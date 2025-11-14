import type { NextApiRequest, NextApiResponse } from 'next';
import { taskLoggerService } from '@/lib/services/task-logger.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const { id } = req.query;
    const { type, limit = '100', full = 'false' } = req.query;

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Task ID is required' });
    }

    const logType = type === 'stderr' ? 'stderr' : 'stdout';
    const limitNum = parseInt(limit as string, 10) || 100;
    const isFull = full === 'true';

    if (isFull) {
      // Return full log file
      const content = await taskLoggerService.getFullLog(id, logType);
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(content);
    } else {
      // Return recent logs from DB
      const logs = await taskLoggerService.getRecentLogs(id, limitNum, logType);
      return res.status(200).json({
        taskId: id,
        logType,
        logs,
        count: logs.length,
      });
    }
  } catch (error: any) {
    console.error('[tasks/logs] Error:', error);
    res.status(500).json({
      error: 'Failed to get task logs',
      message: error.message,
    });
  }
}

