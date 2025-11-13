import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;
  const { enabled = true } = req.body;

  try {
    const pool = getDbPool();
    
    // Get subscription details
    const subResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [id]);

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const subscription = subResult.rows[0];
    const targetPool = createSourceTargetPool(subscription.target_db_connection);

    try {
      const subscriptionName = subscription.subscription_name || subscription.name;
      const escapedSubName = subscriptionName.replace(/"/g, '""');

      if (enabled) {
        await targetPool.query(`ALTER SUBSCRIPTION "${escapedSubName}" ENABLE`);
      } else {
        await targetPool.query(`ALTER SUBSCRIPTION "${escapedSubName}" DISABLE`);
      }

      // Update monitoring database
      await pool.query(`
        UPDATE subscriptions SET enabled = $1 WHERE id = $2
      `, [enabled, id]);

      res.status(200).json({
        success: true,
        enabled,
        message: `Subscription ${enabled ? 'enabled' : 'disabled'} successfully`,
      });
    } finally {
      await targetPool.end();
    }
  } catch (error: any) {
    console.error('Error toggling subscription:', error);
    res.status(500).json({
      error: error.message || 'Failed to toggle subscription',
      details: error.detail,
    });
  }
}

