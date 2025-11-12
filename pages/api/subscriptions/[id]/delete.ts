import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    res.setHeader('Allow', ['DELETE', 'POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;
  const { 
    dropSubscription = true,
    dropPublication = false,
    dropSlot = false,
  } = req.body || {};

  try {
    const pool = getDbPool();
    
    // Get subscription details
    const subResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [id]).catch(() =>
      pool.query(`
        SELECT * FROM replication_groups WHERE id = $1
      `, [id])
    );

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const subscription = subResult.rows[0];
    const sourcePool = createSourceTargetPool(subscription.source_db_connection);
    const targetPool = createSourceTargetPool(subscription.target_db_connection);

    const results = {
      subscriptionDropped: false,
      publicationDropped: false,
      slotDropped: false,
      monitoringRemoved: false,
      errors: [] as string[],
    };

    try {
      const subscriptionName = subscription.subscription_name || subscription.name;
      const publicationName = subscription.publication_name;
      const slotName = subscription.slot_name;

      // Step 1: Drop subscription on target
      if (dropSubscription) {
        try {
          const escapedSubName = subscriptionName.replace(/"/g, '""');
          await targetPool.query(`DROP SUBSCRIPTION IF EXISTS "${escapedSubName}"`);
          results.subscriptionDropped = true;
        } catch (error: any) {
          results.errors.push(`Failed to drop subscription: ${error.message}`);
        }
      }

      // Step 2: Drop publication on source (optional, usually we keep it)
      if (dropPublication) {
        try {
          const escapedPubName = publicationName.replace(/"/g, '""');
          await sourcePool.query(`DROP PUBLICATION IF EXISTS "${escapedPubName}"`);
          results.publicationDropped = true;
        } catch (error: any) {
          results.errors.push(`Failed to drop publication: ${error.message}`);
        }
      }

      // Step 3: Drop replication slot on source (optional, usually dropped with subscription)
      if (dropSlot && slotName) {
        try {
          const escapedSlotName = slotName.replace(/'/g, "''");
          await sourcePool.query(`SELECT pg_drop_replication_slot('${escapedSlotName}')`);
          results.slotDropped = true;
        } catch (error: any) {
          results.errors.push(`Failed to drop slot: ${error.message}`);
        }
      }

      // Step 4: Remove from monitoring database
      try {
        await pool.query(`DELETE FROM subscriptions WHERE id = $1`, [id]).catch(() =>
          pool.query(`DELETE FROM replication_groups WHERE id = $1`, [id])
        );
        // Also delete related tables
        await pool.query(`DELETE FROM subscription_tables WHERE subscription_id = $1`, [id]).catch(() =>
          pool.query(`DELETE FROM replication_group_tables WHERE group_id = $1`, [id])
        );
        results.monitoringRemoved = true;
      } catch (error: any) {
        results.errors.push(`Failed to remove from monitoring: ${error.message}`);
      }

      if (results.errors.length > 0 && !results.subscriptionDropped) {
        return res.status(500).json({
          error: 'Failed to delete subscription',
          details: results.errors,
        });
      }

      res.status(200).json({
        success: true,
        message: 'Subscription deleted successfully',
        results,
      });
    } finally {
      await sourcePool.end();
      await targetPool.end();
    }
  } catch (error: any) {
    console.error('Error deleting subscription:', error);
    res.status(500).json({
      error: error.message || 'Failed to delete subscription',
      details: error.detail,
    });
  }
}

