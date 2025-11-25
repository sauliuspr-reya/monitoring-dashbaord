import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Pipeline ID required' });
  }

  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) {
    return res.status(500).json({ error: 'SOURCE_DATABASE_URL not configured' });
  }

  let sourcePool;
  try {
    sourcePool = createSourceTargetPool(sourceUrl);
    const monitoringPool = getDbPool();

    // First, try to find as a backup task
    const taskResult = await monitoringPool.query(`
      SELECT 
        id, status, filename, filepath, file_size, tables,
        slot_name, publication_name, slot_initial_lsn,
        created_at, completed_at,
        metadata->>'serviceName' as service_name
      FROM backup_tasks
      WHERE id = $1 AND task_type = 'backup'
    `, [id]);

    let pipeline: any = null;

    if (taskResult.rows.length > 0) {
      const task = taskResult.rows[0];
      const tables = task.tables ? (typeof task.tables === 'string' ? JSON.parse(task.tables) : task.tables) : [];
      
      pipeline = {
        id: task.id,
        name: task.service_name || task.filename || `Backup ${task.id.substring(0, 8)}`,
        type: 'backup',
        backup: {
          taskId: task.id,
          status: task.status,
          filename: task.filename,
          filepath: task.filepath,
          fileSize: task.file_size,
          tables,
          tableCount: tables.length,
          createdAt: task.created_at,
          completedAt: task.completed_at,
          serviceName: task.service_name,
        },
        pipelineStatus: task.status === 'completed' ? 'complete' : task.status === 'running' ? 'running' : 'error',
        warnings: [],
      };

      // Get publication info
      if (task.publication_name) {
        try {
          const pubResult = await sourcePool.query(`
            SELECT 
              p.pubname as name,
              p.puballtables as all_tables,
              (SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = p.pubname) as table_count
            FROM pg_publication p
            WHERE p.pubname = $1
          `, [task.publication_name]);

          if (pubResult.rows.length > 0) {
            const pub = pubResult.rows[0];
            
            // Get tables
            const pubTablesResult = await sourcePool.query(`
              SELECT schemaname || '.' || tablename as table_name
              FROM pg_publication_tables
              WHERE pubname = $1
              ORDER BY schemaname, tablename
            `, [task.publication_name]);

            pipeline.publication = {
              name: pub.name,
              tableCount: parseInt(pub.table_count, 10),
              allTables: pub.all_tables,
              tables: pubTablesResult.rows.map((r: any) => r.table_name),
            };
          }
        } catch (e) {
          console.warn('Failed to get publication:', e);
        }
      }

      // Get slot info
      if (task.slot_name) {
        try {
          const slotResult = await sourcePool.query(`
            SELECT 
              slot_name as name,
              active,
              restart_lsn,
              confirmed_flush_lsn,
              pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint as wal_lag_bytes,
              pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as wal_lag_pretty
            FROM pg_replication_slots
            WHERE slot_name = $1
          `, [task.slot_name]);

          if (slotResult.rows.length > 0) {
            const slot = slotResult.rows[0];
            pipeline.slot = {
              name: slot.name,
              active: slot.active,
              restartLsn: slot.restart_lsn,
              confirmedFlushLsn: slot.confirmed_flush_lsn,
              walLagBytes: parseInt(slot.wal_lag_bytes || '0', 10),
              walLagPretty: slot.wal_lag_pretty || '0 bytes',
            };

            if (!slot.active && parseInt(slot.wal_lag_bytes || '0', 10) > 100 * 1024 * 1024) {
              pipeline.warnings.push(`Slot accumulating WAL: ${slot.wal_lag_pretty}`);
              pipeline.pipelineStatus = 'wal-accumulating';
            }
          }
        } catch (e) {
          console.warn('Failed to get slot:', e);
        }
      }

      // Get restore task
      const restoreResult = await monitoringPool.query(`
        SELECT id, status, created_at, completed_at
        FROM backup_tasks
        WHERE task_type = 'restore' AND metadata->>'sourceBackupId' = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [task.id]);

      if (restoreResult.rows.length > 0) {
        const restore = restoreResult.rows[0];
        pipeline.restore = {
          taskId: restore.id,
          status: restore.status,
          createdAt: restore.created_at,
          completedAt: restore.completed_at,
        };
      } else if (task.status === 'completed') {
        pipeline.pipelineStatus = 'needs-restore';
      }

      // Get subscription
      const subResult = await monitoringPool.query(`
        SELECT id, name, subscription_name, enabled, data_copy, created_at
        FROM subscriptions
        WHERE publication_name LIKE $1 OR slot_name = $2
        LIMIT 1
      `, [`%${task.publication_name}%`, task.slot_name]);

      if (subResult.rows.length > 0) {
        const sub = subResult.rows[0];
        pipeline.subscription = {
          id: sub.id,
          name: sub.name,
          enabled: sub.enabled,
          dataCopy: sub.data_copy,
          createdAt: sub.created_at,
          status: sub.enabled ? 'active' : 'stopped',
          lagBytes: 0,
          lagSeconds: 0,
        };
        if (sub.enabled) {
          pipeline.pipelineStatus = 'complete';
        }
      } else if (pipeline.restore?.status === 'completed') {
        pipeline.pipelineStatus = 'needs-subscription';
      }
    } else {
      // Try to find as a manual publication
      try {
        const pubResult = await sourcePool.query(`
          SELECT 
            p.pubname as name,
            p.puballtables as all_tables,
            (SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = p.pubname) as table_count
          FROM pg_publication p
          WHERE p.pubname = $1
        `, [id]);

        if (pubResult.rows.length > 0) {
          const pub = pubResult.rows[0];
          
          const pubTablesResult = await sourcePool.query(`
            SELECT schemaname || '.' || tablename as table_name
            FROM pg_publication_tables
            WHERE pubname = $1
            ORDER BY schemaname, tablename
          `, [id]);

          pipeline = {
            id,
            name: id,
            type: 'manual',
            publication: {
              name: pub.name,
              tableCount: parseInt(pub.table_count, 10),
              allTables: pub.all_tables,
              tables: pubTablesResult.rows.map((r: any) => r.table_name),
            },
            pipelineStatus: 'needs-subscription',
            warnings: ['Manual publication - no backup for gap-free replication'],
          };

          // Check for subscription
          const subResult = await monitoringPool.query(`
            SELECT id, name, subscription_name, enabled, data_copy, created_at
            FROM subscriptions
            WHERE publication_name LIKE $1
            LIMIT 1
          `, [`%${id}%`]);

          if (subResult.rows.length > 0) {
            const sub = subResult.rows[0];
            pipeline.subscription = {
              id: sub.id,
              name: sub.name,
              enabled: sub.enabled,
              dataCopy: sub.data_copy,
              createdAt: sub.created_at,
              status: sub.enabled ? 'active' : 'stopped',
              lagBytes: 0,
              lagSeconds: 0,
            };
            pipeline.pipelineStatus = sub.enabled ? 'complete' : 'needs-subscription';
          }
        }
      } catch (e) {
        console.warn('Failed to find publication:', e);
      }
    }

    if (!pipeline) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }

    res.status(200).json(pipeline);
  } catch (error: any) {
    console.error('[replication/pipelines/[id]] Error:', error);
    res.status(500).json({ error: 'Failed to load pipeline', details: error.message });
  } finally {
    if (sourcePool) await sourcePool.end();
  }
}
