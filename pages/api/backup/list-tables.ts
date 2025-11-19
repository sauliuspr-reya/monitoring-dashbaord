import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

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
      try {
        const fileStats = await fs.stat(filepath);
        const fileSizeMB = fileStats.size / (1024 * 1024);
        
        let backupContent: string;
        
        // For large files, read only the first 100MB (should contain all CREATE TABLE statements)
        if (fileSizeMB > 500) {
          const fileHandle = await fs.open(filepath, 'r');
          const buffer = Buffer.alloc(100 * 1024 * 1024);
          await fileHandle.read(buffer, 0, buffer.length, 0);
          await fileHandle.close();
          backupContent = buffer.toString('utf-8');
        } else {
          backupContent = await fs.readFile(filepath, 'utf-8');
        }
        
        // Extract table names from CREATE TABLE statements
        const createTableMatches = backupContent.match(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?["']?([^\s("']+)["']?/gim) || [];
        // Also get from COPY statements (for data-only dumps)
        const copyMatches = backupContent.match(/^COPY\s+(?:public\.)?["']?([^\s("']+)["']?/gm) || [];
        
        // Combine and deduplicate
        const allMatches = [...createTableMatches, ...copyMatches];
        const tableSet = new Set<string>();
        
        for (const match of allMatches) {
          // Extract table name (remove CREATE TABLE, COPY, quotes, etc.)
          const tableName = match
            .replace(/^(CREATE TABLE|COPY)\s+(?:IF NOT EXISTS\s+)?(?:public\.)?/i, '')
            .replace(/["']/g, '')
            .split(/\s|\(/)[0]
            .trim();
          
          if (tableName && !tableName.startsWith('pg_')) {
            tableSet.add(tableName);
          }
        }
        
        tables = Array.from(tableSet).sort();
      } catch (error: any) {
        console.error('[list-tables] Error reading backup file:', error);
        return res.status(500).json({ 
          error: 'Failed to read backup file',
          message: error.message 
        });
      }
    }

    res.status(200).json({
      success: true,
      filename,
      tables,
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

