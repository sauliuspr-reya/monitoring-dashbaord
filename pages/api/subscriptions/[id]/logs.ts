import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { ReplicationLogsService } from '@/lib/services/replication-logs.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;
  const { limit = '200', category } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Subscription ID is required' });
  }

  try {
    const pool = getDbPool();
    const logsService = new ReplicationLogsService();

    // Get subscription details
    const subResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [id]);

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const subscription = subResult.rows[0];
    const sourcePool = createSourceTargetPool(subscription.source_db_connection);
    const targetPool = createSourceTargetPool(subscription.target_db_connection);

    try {
      let logs;

      // Fetch specific category or all logs
      if (category === 'worker') {
        logs = await logsService.getSubscriptionWorkerLogs(
          targetPool,
          subscription.subscription_name,
          parseInt(limit as string, 10)
        );
      } else if (category === 'sync') {
        logs = await logsService.getTableSyncLogs(
          targetPool,
          subscription.subscription_name,
          parseInt(limit as string, 10)
        );
      } else if (category === 'conflict') {
        logs = await logsService.getConflictLogs(
          targetPool,
          parseInt(limit as string, 10)
        );
      } else if (category === 'error') {
        logs = await logsService.getReplicationErrors(
          targetPool,
          subscription.subscription_name
        );
      } else if (category === 'slot') {
        logs = await logsService.getReplicationSlotLogs(
          sourcePool,
          subscription.subscription_name
        );
      } else {
        // Get all logs
        logs = await logsService.getAllLogs(
          sourcePool,
          targetPool,
          subscription.subscription_name,
          parseInt(limit as string, 10)
        );
      }

      res.status(200).json({
        logs,
        subscription: {
          id: subscription.id,
          name: subscription.subscription_name,
          publicationName: subscription.publication_name
        },
        metadata: {
          count: logs.length,
          category: category || 'all',
          timestamp: new Date()
        }
      });

    } finally {
      await sourcePool.end();
      await targetPool.end();
    }

  } catch (error: any) {
    console.error('Error fetching replication logs:', error);
    res.status(500).json({
      error: 'Failed to fetch replication logs',
      details: error.message
    });
  }
}
