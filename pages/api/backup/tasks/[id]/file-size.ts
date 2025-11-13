import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';
import { promises as fs } from 'fs';

const backupTaskService = new BackupTaskService();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  try {
    const task = await backupTaskService.getTask(id);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // If task has filepath, try to get current file size
    let fileSize = task.file_size || 0;
    
    if (task.filepath && task.status === 'running') {
      try {
        const stats = await fs.stat(task.filepath);
        fileSize = stats.size;
        
        // Update task with current file size if it's different
        if (fileSize !== task.file_size) {
          const metadata = task.metadata || {};
          await backupTaskService.updateTask(id, { 
            file_size: fileSize,
            metadata: {
              ...metadata,
              lastFileSizeUpdate: new Date().toISOString(),
            },
          });
        }
      } catch (error: any) {
        // File might not exist yet or not accessible, use stored size
        if (error.code !== 'ENOENT') {
          console.warn(`[backup/tasks/file-size] Could not stat file ${task.filepath}:`, error.message);
        }
      }
    }

    res.status(200).json({ 
      fileSize,
      taskId: id,
    });
  } catch (error: any) {
    console.error('[backup/tasks/file-size] Error getting file size:', error);
    res.status(500).json({
      error: 'Failed to get file size',
      message: error.message,
    });
  }
}


