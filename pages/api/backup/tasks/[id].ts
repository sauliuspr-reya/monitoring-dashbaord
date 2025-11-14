import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';
import { backupTaskStreamingService } from '@/lib/services/backup-task-streaming.service';

const backupTaskService = new BackupTaskService();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { id } = req.query;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  if (req.method === 'GET') {
    // Get task status
    try {
      const task = await backupTaskService.getTask(id);
      
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      res.status(200).json({ task });
    } catch (error: any) {
      console.error('[backup/tasks] Error getting task:', error);
      res.status(500).json({
        error: 'Failed to get task',
        message: error.message,
      });
    }
  } else if (req.method === 'DELETE') {
    // Delete task
    try {
      const { deleteFile } = req.body || {};
      await backupTaskService.deleteTask(id, deleteFile === true);

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
  } else if (req.method === 'POST') {
    // Cancel task (use streaming service to kill running process)
    try {
      await backupTaskStreamingService.cancelTask(id);

      res.status(200).json({
        success: true,
        message: 'Task cancelled successfully',
      });
    } catch (error: any) {
      console.error('[backup/tasks] Error cancelling task:', error);
      res.status(500).json({
        error: 'Failed to cancel task',
        message: error.message,
      });
    }
  } else {
    res.setHeader('Allow', ['GET', 'DELETE', 'POST']);
    res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
}

