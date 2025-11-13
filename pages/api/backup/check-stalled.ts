import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';

const backupTaskService = new BackupTaskService();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', ['POST', 'GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const result = await backupTaskService.checkForStalledTasks();

    res.status(200).json({
      success: true,
      checked: result.checked,
      stalled: result.stalled,
      message: `Checked ${result.checked} tasks, found ${result.stalled} stalled`,
    });
  } catch (error: any) {
    console.error('[backup/check-stalled] Error checking for stalled tasks:', error);
    res.status(500).json({
      error: 'Failed to check for stalled tasks',
      message: error.message,
    });
  }
}

