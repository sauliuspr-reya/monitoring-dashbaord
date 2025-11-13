import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';

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

    // Check if directory exists
    try {
      await fs.access(backupDir);
    } catch {
      return res.status(200).json({ backups: [] });
    }

    // List all .sql files
    const files = await fs.readdir(backupDir);
    const sqlFiles = files.filter(f => f.endsWith('.sql'));

    const backups = await Promise.all(
      sqlFiles.map(async (filename) => {
        const filepath = path.join(backupDir, filename);
        const stats = await fs.stat(filepath);
        return {
          filename,
          filepath,
          size: stats.size,
          created: stats.birthtime || stats.mtime,
          modified: stats.mtime,
        };
      })
    );

    // Sort by creation date (newest first)
    backups.sort((a, b) => b.created.getTime() - a.created.getTime());

    res.status(200).json({
      backups,
      backupDir,
      total: backups.length,
    });
  } catch (error: any) {
    console.error('[backup/list] Error listing backups:', error);
    res.status(500).json({
      error: 'Failed to list backups',
      message: error.message,
    });
  }
}

