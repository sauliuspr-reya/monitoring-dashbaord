import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';

const backupTaskService = new BackupTaskService();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    // List tasks
    try {
      const { status, task_type, limit, offset } = req.query;
      
      const tasks = await backupTaskService.listTasks({
        status: status as any,
        task_type: task_type as any,
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
      });

      res.status(200).json({ tasks });
    } catch (error: any) {
      console.error('[backup/tasks] Error listing tasks:', error);
      res.status(500).json({
        error: 'Failed to list tasks',
        message: error.message,
      });
    }
  } else if (req.method === 'DELETE') {
    // Delete task
    try {
      const { taskId } = req.query;
      const { deleteFile } = req.body || {};

      if (!taskId || typeof taskId !== 'string') {
        return res.status(400).json({ error: 'taskId is required' });
      }

      await backupTaskService.deleteTask(taskId, deleteFile === true);

      res.status(200).json({
        success: true,
        message: 'Task deleted successfully',
      });
    } catch (error: any) {
      console.error('[backup/tasks] Error deleting task:', error);
      res.status(500).json({
        error: 'Failed to delete task',
        message: error.message,
      });
    }
  } else {
    res.setHeader('Allow', ['GET', 'DELETE']);
    res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
}

