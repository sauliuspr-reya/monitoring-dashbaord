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
    dropSlot = true,  // Changed to true to prevent orphaned slots from causing replication lag
  } = req.body || {};

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
          // Use CASCADE to ensure slot is dropped on source if possible
          // This should automatically drop the replication slot on the source database
          await targetPool.query(`DROP SUBSCRIPTION IF EXISTS "${escapedSubName}" CASCADE`);
          results.subscriptionDropped = true;
          console.log(`Dropped subscription '${subscriptionName}' (should auto-drop slot '${slotName}' on source)`);
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

      // Step 3: Drop replication slot on source (if it still exists after DROP SUBSCRIPTION)
      if (dropSlot && slotName) {
        try {
          // Check if slot still exists (it should have been dropped by DROP SUBSCRIPTION CASCADE)
          const slotInfo = await sourcePool.query(`
            SELECT 
              active,
              pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as lag_bytes,
              pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as lag_pretty
            FROM pg_replication_slots
            WHERE slot_name = $1
          `, [slotName]);
          
          if (slotInfo.rows.length > 0) {
            const lagBytes = parseInt(slotInfo.rows[0].lag_bytes || '0', 10);
            const lagPretty = slotInfo.rows[0].lag_pretty;
            const isActive = slotInfo.rows[0].active;
            
            if (lagBytes > 1073741824) { // > 1GB
              console.warn(`Warning: Slot '${slotName}' has ${lagPretty} of WAL lag before dropping`);
            }
            
            if (isActive) {
              console.warn(`Warning: Slot '${slotName}' is still active! Attempting to drop anyway...`);
            }
            
            // Slot still exists, drop it manually
            const escapedSlotName = slotName.replace(/'/g, "''");
            await sourcePool.query(`SELECT pg_drop_replication_slot('${escapedSlotName}')`);
            results.slotDropped = true;
            console.log(`Manually dropped replication slot '${slotName}' on source (${lagPretty} lag)`);
          } else {
            // Slot was already dropped (good - DROP SUBSCRIPTION CASCADE worked)
            results.slotDropped = true;
            console.log(`Replication slot '${slotName}' was already dropped by DROP SUBSCRIPTION CASCADE (good!)`);
          }
        } catch (error: any) {
          // If error is "replication slot does not exist", that's actually OK
          if (error.message.includes('does not exist')) {
            results.slotDropped = true;
            console.log(`Replication slot '${slotName}' already deleted (expected)`);
          } else {
            results.errors.push(`Failed to drop slot: ${error.message}`);
            console.error(`Error dropping slot '${slotName}':`, error.message);
          }
        }
      }

      // Step 4: Remove from monitoring database
      try {
        await pool.query(`DELETE FROM subscriptions WHERE id = $1`, [id]);
        // Also delete related tables
        await pool.query(`DELETE FROM subscription_tables WHERE subscription_id = $1`, [id]);
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

