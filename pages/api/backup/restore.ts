import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';
import { promises as fs } from 'fs';
import path from 'path';

const backupTaskService = new BackupTaskService();

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

function parseConnectionString(connString: string) {
  try {
    const url = new URL(connString);
    return {
      host: url.hostname,
      port: url.port || '5432',
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1).split('?')[0],
    };
  } catch {
    const params: any = {};
    connString.split(' ').forEach(param => {
      const [key, value] = param.split('=');
      if (key && value) {
        params[key] = value;
      }
    });
    return {
      host: params.host || params.hostname,
      port: params.port || '5432',
      user: params.user || params.userid,
      password: params.password || params.pass,
      database: params.database || params.dbname,
    };
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
    const { filename, connectionString, dryRun = false } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Backup filename is required' });
    }

    // Use DESTINATION_DATABASE_URL or TARGET_DATABASE_URL as default if not provided
    const targetConnectionString = connectionString || 
      process.env.DESTINATION_DATABASE_URL || 
      process.env.TARGET_DATABASE_URL;

    if (!targetConnectionString) {
      return res.status(400).json({ 
        error: 'Connection string is required. Provide connectionString in request or set DESTINATION_DATABASE_URL/TARGET_DATABASE_URL environment variable.' 
      });
    }

    // Get backup file path
    const backupDir = await getBackupDir();
    const filepath = path.join(backupDir, filename);

    // Check if file exists
    try {
      await fs.access(filepath);
    } catch {
      return res.status(404).json({ error: `Backup file not found: ${filename}` });
    }

    if (dryRun) {
      // Just verify the file exists and return info
      const stats = await fs.stat(filepath);
      return res.status(200).json({
        success: true,
        dryRun: true,
        filename,
        filepath,
        fileSize: stats.size,
        message: 'Dry run: File exists and is ready to restore',
      });
    }

    // Create background restore task
    const task = await backupTaskService.createTask('restore', {
      filename,
      connectionString: targetConnectionString,
      createdBy: req.headers['x-user'] as string || undefined,
    });

    // Update task with filepath
    await backupTaskService.updateTask(task.id, { filepath });

    // Start restore in background (don't wait for completion)
    backupTaskService.executeRestoreTask(task.id, targetConnectionString).catch((error) => {
      console.error(`[restore] Background task ${task.id} failed:`, error);
    });

    res.status(202).json({
      success: true,
      taskId: task.id,
      status: 'pending',
      message: 'Restore task created and queued',
    });
  } catch (error: any) {
    console.error('[restore] Error creating restore task:', error);
    res.status(500).json({
      error: 'Failed to create restore task',
      message: error.message,
    });
  }
}

