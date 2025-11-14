import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';
import { getDbPool } from '@/lib/db/connection';

async function getBackupDir(): Promise<string> {
  if (process.env.BACKUP_DIR) {
    return process.env.BACKUP_DIR;
  }
  
  // Check if /backup exists (Kubernetes pod)
  try {
    await fs.access('/backup');
    return '/backup';
  } catch {
    return './backup';
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const backupDir = await getBackupDir();
    const pool = getDbPool();

    // Get files from filesystem
    const filesystemBackups = new Map<string, any>();
    
    try {
      await fs.access(backupDir);
      
      // List all backup files (.sql, .dump, .backup, .gz)
      const files = await fs.readdir(backupDir);
      const backupExtensions = ['.sql', '.dump', '.backup', '.sql.gz', '.dump.gz'];
      const backupFiles = files.filter(f => 
        backupExtensions.some(ext => f.endsWith(ext))
      );

      for (const filename of backupFiles) {
        const filepath = path.join(backupDir, filename);
        try {
          const stats = await fs.stat(filepath);
          filesystemBackups.set(filename, {
            filename,
            filepath,
            size: stats.size,
            created: stats.birthtime || stats.mtime,
            modified: stats.mtime,
            exists: true,
          });
        } catch (error) {
          // File might have been deleted between readdir and stat
          console.warn(`[backup/list] File ${filename} not accessible:`, error);
        }
      }
    } catch (error) {
      // Directory doesn't exist, continue with database-only backups
      console.warn('[backup/list] Backup directory not accessible:', error);
    }

    // Get completed backup tasks from database
    const dbBackups = await pool.query(`
      SELECT 
        id,
        filename,
        filepath,
        file_size,
        created_at,
        completed_at,
        tables,
        task_type
      FROM backup_tasks
      WHERE 
        task_type = 'backup'
        AND status = 'completed'
        AND filename IS NOT NULL
      ORDER BY completed_at DESC NULLS LAST, created_at DESC
    `);

    // Merge filesystem and database backups
    const allBackups = new Map<string, any>();

    // Add filesystem backups first
    filesystemBackups.forEach((backup, filename) => {
      allBackups.set(filename, backup);
    });

    // Add database backups (will override filesystem if exists, or add as missing)
    for (const row of dbBackups.rows) {
      const filename = row.filename;
      if (!allBackups.has(filename)) {
        // File not found on filesystem, but task exists
        allBackups.set(filename, {
          filename,
          filepath: row.filepath || path.join(backupDir, filename),
          size: row.file_size || 0,
          created: row.completed_at || row.created_at,
          modified: row.completed_at || row.created_at,
          exists: false, // File missing from filesystem
          taskId: row.id,
          tables: row.tables,
        });
      } else {
        // File exists, add task metadata
        const backup = allBackups.get(filename);
        backup.taskId = row.id;
        backup.tables = row.tables;
      }
    }

    // Convert to array and sort by creation date (newest first)
    const backups = Array.from(allBackups.values());
    backups.sort((a, b) => {
      const aTime = a.created instanceof Date ? a.created.getTime() : new Date(a.created).getTime();
      const bTime = b.created instanceof Date ? b.created.getTime() : new Date(b.created).getTime();
      return bTime - aTime;
    });

    res.status(200).json({
      backups,
      backupDir,
      total: backups.length,
      filesystemCount: Array.from(filesystemBackups.values()).length,
      databaseCount: dbBackups.rows.length,
    });
  } catch (error: any) {
    console.error('[backup/list] Error listing backups:', error);
    res.status(500).json({
      error: 'Failed to list backups',
      message: error.message,
    });
  }
}

