import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { promises as fs } from 'fs';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  const { artifactType } = req.body;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Pipeline ID required' });
  }

  if (!['subscription', 'slot', 'publication', 'backup'].includes(artifactType)) {
    return res.status(400).json({ error: 'Invalid artifact type' });
  }

  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;

  let sourcePool, targetPool;
  try {
    const monitoringPool = getDbPool();

    // Get backup task info
    const taskResult = await monitoringPool.query(`
      SELECT id, slot_name, publication_name, filepath, filename
      FROM backup_tasks
      WHERE id = $1 AND task_type = 'backup'
    `, [id]);

    const task = taskResult.rows[0];

    switch (artifactType) {
      case 'subscription': {
        // Find and delete subscription
        const subResult = await monitoringPool.query(`
          SELECT id, name, subscription_name, source_db_connection, target_db_connection
          FROM subscriptions
          WHERE publication_name LIKE $1 OR slot_name = $2
          LIMIT 1
        `, [task ? `%${task.publication_name}%` : `%${id}%`, task?.slot_name]);

        if (subResult.rows.length === 0) {
          return res.status(404).json({ error: 'Subscription not found' });
        }

        const sub = subResult.rows[0];
        const subTargetUrl = sub.target_db_connection || targetUrl;
        
        if (!subTargetUrl) {
          return res.status(500).json({ error: 'Target database connection not configured' });
        }

        targetPool = createSourceTargetPool(subTargetUrl);
        
        // Drop subscription on target
        const escapedSubName = sub.subscription_name.replace(/"/g, '""');
        await targetPool.query(`DROP SUBSCRIPTION IF EXISTS "${escapedSubName}"`);

        // Remove from monitoring DB
        await monitoringPool.query(`DELETE FROM subscriptions WHERE id = $1`, [sub.id]);
        await monitoringPool.query(`DELETE FROM subscription_tables WHERE subscription_id = $1`, [sub.id]);

        return res.status(200).json({ success: true, message: 'Subscription deleted' });
      }

      case 'slot': {
        if (!sourceUrl) {
          return res.status(500).json({ error: 'SOURCE_DATABASE_URL not configured' });
        }

        const slotName = task?.slot_name || id;
        sourcePool = createSourceTargetPool(sourceUrl);

        // Check if slot exists and is not active
        const slotCheck = await sourcePool.query(`
          SELECT active FROM pg_replication_slots WHERE slot_name = $1
        `, [slotName]);

        if (slotCheck.rows.length === 0) {
          return res.status(404).json({ error: 'Slot not found' });
        }

        if (slotCheck.rows[0].active) {
          return res.status(400).json({ error: 'Cannot drop active slot. Disable subscription first.' });
        }

        // Drop slot
        await sourcePool.query(`SELECT pg_drop_replication_slot($1)`, [slotName]);

        return res.status(200).json({ success: true, message: 'Slot dropped' });
      }

      case 'publication': {
        if (!sourceUrl) {
          return res.status(500).json({ error: 'SOURCE_DATABASE_URL not configured' });
        }

        const pubName = task?.publication_name || id;
        sourcePool = createSourceTargetPool(sourceUrl);

        // Check if publication exists
        const pubCheck = await sourcePool.query(`
          SELECT 1 FROM pg_publication WHERE pubname = $1
        `, [pubName]);

        if (pubCheck.rows.length === 0) {
          return res.status(404).json({ error: 'Publication not found' });
        }

        // Drop publication
        const escapedPubName = pubName.replace(/"/g, '""');
        await sourcePool.query(`DROP PUBLICATION IF EXISTS "${escapedPubName}"`);

        return res.status(200).json({ success: true, message: 'Publication dropped' });
      }

      case 'backup': {
        if (!task) {
          return res.status(404).json({ error: 'Backup task not found' });
        }

        if (task.filepath) {
          try {
            await fs.unlink(task.filepath);
          } catch (e: any) {
            if (e.code !== 'ENOENT') {
              console.warn('Failed to delete backup file:', e);
            }
          }
        }

        // Mark as deleted in monitoring DB
        await monitoringPool.query(`
          UPDATE backup_tasks 
          SET status = 'deleted', filepath = NULL, file_size = NULL
          WHERE id = $1
        `, [id]);

        return res.status(200).json({ success: true, message: 'Backup file deleted' });
      }
    }
  } catch (error: any) {
    console.error('[delete-artifact] Error:', error);
    res.status(500).json({ error: 'Failed to delete artifact', details: error.message });
  } finally {
    if (sourcePool) await sourcePool.end();
    if (targetPool) await targetPool.end();
  }
}
