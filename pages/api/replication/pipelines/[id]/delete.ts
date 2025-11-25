import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { promises as fs } from 'fs';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  const { subscription = true, slot = true, publication = true, backup = false } = req.body;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Pipeline ID required' });
  }

  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;

  const results: Record<string, { success: boolean; message?: string; error?: string }> = {};
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
    const pubName = task?.publication_name || id;
    const slotName = task?.slot_name;

    // 1. Delete subscription first (it depends on slot)
    if (subscription) {
      try {
        const subResult = await monitoringPool.query(`
          SELECT id, name, subscription_name, source_db_connection, target_db_connection, slot_name
          FROM subscriptions
          WHERE publication_name LIKE $1 OR slot_name = $2
        `, [`%${pubName}%`, slotName]);

        for (const sub of subResult.rows) {
          const subTargetUrl = sub.target_db_connection || targetUrl;
          if (subTargetUrl) {
            try {
              targetPool = createSourceTargetPool(subTargetUrl);
              const escapedSubName = sub.subscription_name.replace(/"/g, '""');
              await targetPool.query(`DROP SUBSCRIPTION IF EXISTS "${escapedSubName}"`);
              await targetPool.end();
              targetPool = undefined;
            } catch (e: any) {
              console.warn('Failed to drop subscription on target:', e.message);
            }
          }

          await monitoringPool.query(`DELETE FROM subscription_tables WHERE subscription_id = $1`, [sub.id]);
          await monitoringPool.query(`DELETE FROM subscriptions WHERE id = $1`, [sub.id]);
        }

        results.subscription = { success: true, message: `Deleted ${subResult.rows.length} subscription(s)` };
      } catch (e: any) {
        results.subscription = { success: false, error: e.message };
      }
    }

    // 2. Drop slot (after subscription is gone)
    if (slot && slotName && sourceUrl) {
      try {
        sourcePool = createSourceTargetPool(sourceUrl);

        const slotCheck = await sourcePool.query(`
          SELECT active FROM pg_replication_slots WHERE slot_name = $1
        `, [slotName]);

        if (slotCheck.rows.length > 0) {
          if (slotCheck.rows[0].active) {
            results.slot = { success: false, error: 'Slot is still active' };
          } else {
            await sourcePool.query(`SELECT pg_drop_replication_slot($1)`, [slotName]);
            results.slot = { success: true, message: 'Slot dropped' };
          }
        } else {
          results.slot = { success: true, message: 'Slot already gone' };
        }
      } catch (e: any) {
        if (e.message.includes('does not exist')) {
          results.slot = { success: true, message: 'Slot already gone' };
        } else {
          results.slot = { success: false, error: e.message };
        }
      }
    }

    // 3. Drop publication
    if (publication && pubName && sourceUrl) {
      try {
        if (!sourcePool) {
          sourcePool = createSourceTargetPool(sourceUrl);
        }

        const pubCheck = await sourcePool.query(`
          SELECT 1 FROM pg_publication WHERE pubname = $1
        `, [pubName]);

        if (pubCheck.rows.length > 0) {
          const escapedPubName = pubName.replace(/"/g, '""');
          await sourcePool.query(`DROP PUBLICATION IF EXISTS "${escapedPubName}"`);
          results.publication = { success: true, message: 'Publication dropped' };
        } else {
          results.publication = { success: true, message: 'Publication already gone' };
        }
      } catch (e: any) {
        results.publication = { success: false, error: e.message };
      }
    }

    // 4. Delete backup file
    if (backup && task?.filepath) {
      try {
        await fs.unlink(task.filepath);
        results.backup = { success: true, message: 'Backup file deleted' };
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          results.backup = { success: true, message: 'Backup file already gone' };
        } else {
          results.backup = { success: false, error: e.message };
        }
      }
    }

    // 5. Update/delete backup task record
    if (task) {
      if (backup) {
        await monitoringPool.query(`DELETE FROM backup_tasks WHERE id = $1`, [id]);
      } else {
        await monitoringPool.query(`
          UPDATE backup_tasks 
          SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{pipelineDeleted}', 'true')
          WHERE id = $1
        `, [id]);
      }
    }

    const allSuccess = Object.values(results).every(r => r.success);
    res.status(allSuccess ? 200 : 207).json({
      success: allSuccess,
      results,
      message: allSuccess ? 'Pipeline deleted successfully' : 'Some operations failed',
    });
  } catch (error: any) {
    console.error('[delete-pipeline] Error:', error);
    res.status(500).json({ error: 'Failed to delete pipeline', details: error.message, results });
  } finally {
    if (sourcePool) await sourcePool.end();
    if (targetPool) await targetPool.end();
  }
}
