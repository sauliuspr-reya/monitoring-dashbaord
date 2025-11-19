import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createSourceTargetPool } from '@/lib/db/connection';

const execAsync = promisify(exec);

async function getBackupDir(): Promise<string> {
  if (process.env.BACKUP_DIR) {
    return process.env.BACKUP_DIR;
  }
  
  try {
    await fs.access('/backup');
    return '/backup';
  } catch {
    return path.join(process.cwd(), 'backup');
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Backup filename is required' });
    }

    const backupDir = await getBackupDir();
    const filepath = path.join(backupDir, filename);

    // Check if file exists
    try {
      await fs.access(filepath);
    } catch {
      return res.status(404).json({ error: `Backup file not found: ${filename}` });
    }

    const isCustomFormat = filepath.endsWith('.dump') || filepath.endsWith('.backup');
    const isCompressed = filepath.endsWith('.gz');

    let tables: string[] = [];
    let tableInfo: Array<{ name: string; rowCount?: number; size?: number }> = [];

    if (isCustomFormat) {
      // Use pg_restore --list to get table list from custom format
      try {
        const { stdout } = await execAsync(`pg_restore --list "${filepath}"`);
        // Parse pg_restore list output
        // Format: "TABLE; schema owner table_name"
        const tableMatches = stdout.match(/^TABLE;\s+(\w+)\s+\w+\s+(\w+)/gm) || [];
        tables = tableMatches.map(match => {
          const parts = match.split(/\s+/);
          const schema = parts[1];
          const tableName = parts[parts.length - 1];
          return schema === 'public' ? tableName : `${schema}.${tableName}`;
        });
      } catch (error: any) {
        console.error('[list-tables] Error listing tables from custom format:', error);
        return res.status(500).json({ 
          error: 'Failed to list tables from backup file',
          message: error.message 
        });
      }
    } else {
      // For plain SQL files, read and parse
      let fileSizeMB = 0;
      try {
        const fileStats = await fs.stat(filepath);
        fileSizeMB = fileStats.size / (1024 * 1024);
        
        // For very large files (>10GB), use streaming approach to avoid memory issues
        if (fileSizeMB > 10000) {
          // Use streaming to read first portion of file
          const readSize = Math.min(50 * 1024 * 1024, fileStats.size); // Read first 50MB max
          const fileHandle = await fs.open(filepath, 'r');
          const buffer = Buffer.alloc(readSize);
          const { bytesRead } = await fileHandle.read(buffer, 0, readSize, 0);
          await fileHandle.close();
          
          const backupContent = buffer.toString('utf-8', 0, bytesRead);
          
          // Extract table names using more efficient regex
          const tableSet = new Set<string>();
          
          // Match CREATE TABLE statements
          const createTableRegex = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gim;
          let match;
          while ((match = createTableRegex.exec(backupContent)) !== null) {
            const tableName = match[1];
            if (tableName && !tableName.startsWith('pg_')) {
              tableSet.add(tableName);
            }
          }
          
          // Match COPY statements
          const copyRegex = /^COPY\s+(?:public\.)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gim;
          while ((match = copyRegex.exec(backupContent)) !== null) {
            const tableName = match[1];
            if (tableName && !tableName.startsWith('pg_')) {
              tableSet.add(tableName);
            }
          }
          
          tables = Array.from(tableSet).sort();
        } else {
          // For smaller files, read normally
          let backupContent: string;
          
          // For large files, read only the first 50MB (should contain all CREATE TABLE statements)
          if (fileSizeMB > 500) {
            const readSize = Math.min(50 * 1024 * 1024, fileStats.size);
            const fileHandle = await fs.open(filepath, 'r');
            const buffer = Buffer.alloc(readSize);
            const { bytesRead } = await fileHandle.read(buffer, 0, readSize, 0);
            await fileHandle.close();
            backupContent = buffer.toString('utf-8', 0, bytesRead);
          } else {
            backupContent = await fs.readFile(filepath, 'utf-8');
          }
          
          // Extract table names from CREATE TABLE statements
          const createTableMatches = backupContent.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gim) || [];
          // Also get from COPY statements (for data-only dumps)
          const copyMatches = backupContent.match(/^COPY\s+(?:public\.)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gm) || [];
          
          // Combine and deduplicate
          const allMatches = [...createTableMatches, ...copyMatches];
          const tableSet = new Set<string>();
          
          for (const match of allMatches) {
            // Extract table name using regex capture group
            const tableMatch = match.match(/(?:CREATE\s+TABLE|COPY)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/i);
            if (tableMatch && tableMatch[1]) {
              const tableName = tableMatch[1];
              if (tableName && !tableName.startsWith('pg_')) {
                tableSet.add(tableName);
              }
            }
          }
          
          tables = Array.from(tableSet).sort();
        }
      } catch (error: any) {
        console.error('[list-tables] Error reading backup file:', error);
        return res.status(500).json({ 
          error: 'Failed to read backup file',
          message: error.message,
          details: fileSizeMB > 10000 ? 'File is very large. Try using a custom format (.dump) backup for better performance.' : undefined
        });
      }
    }

    // Get table sizes and row counts from source database if available
    try {
      const sourceConnectionString = process.env.SOURCE_DATABASE_URL;
      if (sourceConnectionString && tables.length > 0) {
        const sourcePool = createSourceTargetPool(sourceConnectionString);
        try {
          // Query all tables at once for efficiency using array parameter
          const statsQuery = `
            SELECT 
              c.relname as table_name,
              COALESCE(s.n_live_tup::bigint, c.reltuples::bigint, 0) as row_count,
              pg_total_relation_size(c.oid) as size_bytes
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid AND s.schemaname = n.nspname
            WHERE c.relname = ANY($1::text[])
              AND n.nspname = 'public'
              AND c.relkind = 'r'
          `;
          
          const statsResult = await sourcePool.query(statsQuery, [tables]);
          const statsMap = new Map<string, { rowCount: number; size: number }>();
          
          for (const row of statsResult.rows) {
            statsMap.set(row.table_name, {
              rowCount: parseInt(row.row_count || '0', 10),
              size: parseInt(row.size_bytes || '0', 10),
            });
          }
          
          // Build table info array
          tableInfo = tables.map(tableName => ({
            name: tableName,
            rowCount: statsMap.get(tableName)?.rowCount,
            size: statsMap.get(tableName)?.size,
          }));
        } catch (dbError: any) {
          console.warn('[list-tables] Could not fetch table stats from source database:', dbError.message);
          // Continue without stats
          tableInfo = tables.map(name => ({ name }));
        } finally {
          await sourcePool.end();
        }
      } else {
        // No source connection or no tables, just return table names
        tableInfo = tables.map(name => ({ name }));
      }
    } catch (error: any) {
      console.warn('[list-tables] Error fetching table stats:', error.message);
      // Continue without stats
      tableInfo = tables.map(name => ({ name }));
    }

    res.status(200).json({
      success: true,
      filename,
      tables,
      tableInfo,
      count: tables.length,
    });
  } catch (error: any) {
    console.error('[list-tables] Error:', error);
    res.status(500).json({
      error: 'Failed to list tables',
      message: error.message,
    });
  }
}

