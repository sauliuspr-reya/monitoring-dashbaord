import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';
import { backupTaskStreamingService } from '@/lib/services/backup-task-streaming.service';
import { promises as fs } from 'fs';
import path from 'path';

const backupTaskService = new BackupTaskService();

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
    const { filename, connectionString, tables, dryRun = false, cleanRestore = false } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Backup filename is required' });
    }

    if (!tables || !Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({ error: 'At least one table must be specified' });
    }

    // Use TARGET_DATABASE_URL as default if not provided
    const targetConnectionString = connectionString || process.env.TARGET_DATABASE_URL;

    if (!targetConnectionString) {
      return res.status(400).json({ 
        error: 'Connection string is required. Provide connectionString in request or set TARGET_DATABASE_URL environment variable.' 
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
      const stats = await fs.stat(filepath);
      return res.status(200).json({
        success: true,
        dryRun: true,
        filename,
        filepath,
        fileSize: stats.size,
        tables,
        tableCount: tables.length,
        message: 'Dry run: Ready to restore selected tables',
      });
    }

    // Create background restore task with table selection
    console.log(`[restore-tables] Creating restore task for file: ${filename}, tables: ${tables.length}`);
    const task = await backupTaskService.createTask('restore', {
      filename,
      connectionString: targetConnectionString,
      createdBy: req.headers['x-user'] as string || undefined,
    });

    console.log(`[restore-tables] Task created with ID: ${task.id}, status: ${task.status}`);

    // Update task with filepath and metadata (tables to restore)
    await backupTaskService.updateTask(task.id, { 
      filepath,
      metadata: {
        ...(task.metadata || {}),
        restoreTables: tables, // Store which tables to restore
        cleanRestore: cleanRestore, // Store clean restore flag
      },
    });

    console.log(`[restore-tables] Starting restore task ${task.id} in background...`);
    // Start restore in background with streaming
    backupTaskStreamingService.executeRestoreTaskStreaming(task.id, targetConnectionString).catch((error) => {
      console.error(`[restore-tables] Background task ${task.id} failed:`, error);
    });

    console.log(`[restore-tables] Restore task ${task.id} queued successfully`);

    res.status(202).json({
      success: true,
      taskId: task.id,
      status: 'pending',
      message: 'Restore task created and queued',
      tables,
      tableCount: tables.length,
    });
  } catch (error: any) {
    console.error('[restore-tables] Error creating restore task:', error);
    res.status(500).json({
      error: 'Failed to create restore task',
      message: error.message,
    });
  }
}

