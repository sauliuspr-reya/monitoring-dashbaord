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

  const { enabled = true } = req.body;

  try {
    const pool = getDbPool();
    
    // Get all subscriptions
    const subResult = await pool.query(`
      SELECT * FROM subscriptions
    `).catch(() =>
      pool.query(`
        SELECT * FROM replication_groups
      `)
    );

    if (subResult.rows.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No subscriptions found',
        processed: 0,
        errors: [],
      });
    }

    const results = {
      processed: 0,
      errors: [] as Array<{ id: string; name: string; error: string }>,
    };

    // Process each subscription
    for (const subscription of subResult.rows) {
      try {
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
          `, [enabled, subscription.id]).catch(() =>
            pool.query(`
              UPDATE replication_groups SET enabled = $1 WHERE id = $2
            `, [enabled, subscription.id])
          );

          results.processed++;
        } finally {
          await targetPool.end();
        }
      } catch (error: any) {
        results.errors.push({
          id: subscription.id,
          name: subscription.subscription_name || subscription.name || 'Unknown',
          error: error.message || 'Failed to toggle subscription',
        });
      }
    }

    res.status(200).json({
      success: true,
      enabled,
      message: `${enabled ? 'Enabled' : 'Disabled'} ${results.processed} subscription(s)`,
      processed: results.processed,
      total: subResult.rows.length,
      errors: results.errors,
    });
  } catch (error: any) {
    console.error('Error bulk toggling subscriptions:', error);
    res.status(500).json({
      error: error.message || 'Failed to bulk toggle subscriptions',
      details: error.detail,
    });
  }
}

