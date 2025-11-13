import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';
import { promises as fs } from 'fs';
import path from 'path';

const backupTaskService = new BackupTaskService();

// Determine backup directory based on environment
async function getBackupDir(): Promise<string> {
  // Check environment variable first
  if (process.env.BACKUP_DIR) {
    return process.env.BACKUP_DIR;
  }
  
  // Check if /backup exists (Kubernetes pod)
  try {
    await fs.access('/backup');
    // Ensure directory is writable
    await fs.chmod('/backup', 0o755).catch(() => {
      // Ignore chmod errors, try to write anyway
    });
    return '/backup';
  } catch {
    return './backup'; // Default for local development
  }
}

// Parse PostgreSQL connection string
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
    // Fallback: assume it's already in key=value format
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
    const { tables, connectionString, schemaOnly = false } = req.body;

    if (!connectionString) {
      return res.status(400).json({ error: 'Connection string is required' });
    }

    if (!tables || !Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({ error: 'At least one table must be specified' });
    }

    // Ensure backup directory exists and is writable
    const backupDir = await getBackupDir();
    try {
      await fs.mkdir(backupDir, { recursive: true });
      // Try to write a test file to check permissions
      const testFile = path.join(backupDir, '.write-test');
      await fs.writeFile(testFile, 'test').catch(() => {
        throw new Error(`Backup directory ${backupDir} is not writable. Check permissions.`);
      });
      await fs.unlink(testFile).catch(() => {});
    } catch (error: any) {
      console.error('[backup] Backup directory error:', error);
      return res.status(500).json({
        error: 'Backup directory is not accessible',
        message: error.message,
        backupDir,
      });
    }

    // Create background task
    const task = await backupTaskService.createTask('backup', {
      tables,
      connectionString,
      schemaOnly,
      createdBy: req.headers['x-user'] as string || undefined,
    });

    // Start backup in background (don't wait for completion)
    backupTaskService.executeBackupTask(task.id, connectionString).catch((error) => {
      console.error(`[backup] Background task ${task.id} failed:`, error);
    });

    res.status(202).json({
      success: true,
      taskId: task.id,
      status: 'pending',
      message: 'Backup task created and queued',
    });
  } catch (error: any) {
    console.error('[backup] Error creating backup task:', error);
    res.status(500).json({
      error: 'Failed to create backup task',
      message: error.message,
    });
  }
}

