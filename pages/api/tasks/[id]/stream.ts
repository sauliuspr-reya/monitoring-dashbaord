import type { NextApiRequest, NextApiResponse } from 'next';
import { taskLoggerService } from '@/lib/services/task-logger.service';

/**
 * Server-Sent Events endpoint for streaming task logs in real-time
 */
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
    const { type = 'stdout' } = req.query;

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Task ID is required' });
    }

    const logType = type === 'stderr' ? 'stderr' : 'stdout';

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', taskId: id, logType })}\n\n`);

    // Stream logs
    try {
      for await (const chunk of taskLoggerService.streamLog(id, logType)) {
        res.write(`data: ${JSON.stringify({ type: 'log', content: chunk })}\n\n`);
      }
    } catch (error: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    }

    // Send close message
    res.write(`data: ${JSON.stringify({ type: 'closed' })}\n\n`);
    res.end();
  } catch (error: any) {
    console.error('[tasks/stream] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to stream task logs',
        message: error.message,
      });
    }
  }
}

