import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

export interface PipelineItem {
  id: string; // publication name or backup task id
  name: string; // display name
  type: 'backup' | 'manual';
  
  // Backup info
  backup?: {
    taskId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    filename?: string;
    fileSize?: number;
    tables?: string[];
    tableCount: number;
    createdAt: string;
    completedAt?: string;
    serviceName?: string;
  };
  
  // Publication info
  publication?: {
    name: string;
    tableCount: number;
    allTables: boolean;
    createdAt?: string;
  };
  
  // Slot info
  slot?: {
    name: string;
    restartLsn: string;
    confirmedFlushLsn: string;
    walLagBytes: number;
    walLagPretty: string;
    active: boolean;
  };
  
  // Restore info
  restore?: {
    taskId: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    createdAt: string;
    completedAt?: string;
    duration?: number;
  };
  
  // Subscription info
  subscription?: {
    id: string;
    name: string;
    enabled: boolean;
    dataCopy: boolean;
    createdAt: string;
    status: 'active' | 'stopped' | 'error';
    lagBytes: number;
    lagSeconds: number;
    startLsn?: string;
  };
  
  // Pipeline status
  pipelineStatus: 'complete' | 'needs-restore' | 'needs-subscription' | 'wal-accumulating' | 'running' | 'error';
  warnings: string[];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) {
    return res.status(500).json({ error: 'SOURCE_DATABASE_URL not configured' });
  }

  let sourcePool;
  try {
    sourcePool = createSourceTargetPool(sourceUrl);
    const monitoringPool = getDbPool();

    // 1. Get backup tasks with their publications/slots
    const backupTasksResult = await monitoringPool.query(`
      SELECT 
        id, status, filename, file_size, tables, 
        slot_name, publication_name, slot_initial_lsn,
        created_at, completed_at,
        metadata->>'serviceName' as service_name
      FROM backup_tasks
      WHERE task_type = 'backup'
      ORDER BY created_at DESC
    `);

    // 2. Get restore tasks
    const restoreTasksResult = await monitoringPool.query(`
      SELECT 
        id, status, filename, created_at, completed_at,
        metadata->>'sourceBackupId' as source_backup_id
      FROM backup_tasks
      WHERE task_type = 'restore'
      ORDER BY created_at DESC
    `);

    // 3. Get subscriptions
    const subscriptionsResult = await monitoringPool.query(`
      SELECT 
        id, name, subscription_name, publication_name, slot_name,
        enabled, data_copy, created_at
      FROM subscriptions
      ORDER BY created_at DESC
    `);

    // 4. Get publications from source
    const pubsResult = await sourcePool.query(`
      SELECT 
        p.pubname as name,
        p.puballtables as all_tables,
        (SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = p.pubname) as table_count
      FROM pg_publication p
      ORDER BY p.pubname
    `);

    // 5. Get slots from source
    const slotsResult = await sourcePool.query(`
      SELECT 
        slot_name as name,
        restart_lsn,
        confirmed_flush_lsn,
        active,
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint as wal_lag_bytes,
        pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as wal_lag_pretty
      FROM pg_replication_slots
      WHERE slot_type = 'logical'
    `);

    // Build lookup maps
    const slotsByName = new Map(slotsResult.rows.map(s => [s.name, s]));
    const pubsByName = new Map(pubsResult.rows.map(p => [p.name, p]));
    const subsByPubName = new Map<string, any>();
    const subsBySlotName = new Map<string, any>();
    
    for (const sub of subscriptionsResult.rows) {
      if (sub.publication_name) {
        subsByPubName.set(sub.publication_name, sub);
      }
      if (sub.slot_name) {
        subsBySlotName.set(sub.slot_name, sub);
      }
    }

    // Group restores by source backup
    const restoresByBackupId = new Map<string, any>();
    for (const restore of restoreTasksResult.rows) {
      if (restore.source_backup_id) {
        restoresByBackupId.set(restore.source_backup_id, restore);
      }
    }

    const pipelines: PipelineItem[] = [];
    const processedPubs = new Set<string>();

    // Process backup tasks first (these are the primary pipeline items)
    for (const task of backupTasksResult.rows) {
      const pubName = task.publication_name;
      const slotName = task.slot_name;
      
      if (pubName) processedPubs.add(pubName);

      const pub = pubName ? pubsByName.get(pubName) : null;
      const slot = slotName ? slotsByName.get(slotName) : null;
      const sub = pubName ? subsByPubName.get(pubName) : (slotName ? subsBySlotName.get(slotName) : null);
      const restore = restoresByBackupId.get(task.id);

      const warnings: string[] = [];
      let pipelineStatus: PipelineItem['pipelineStatus'] = 'complete';

      // Determine pipeline status
      if (task.status === 'running' || task.status === 'pending') {
        pipelineStatus = 'running';
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        pipelineStatus = 'error';
        warnings.push(`Backup ${task.status}`);
      } else if (task.status === 'completed') {
        if (!restore || restore.status !== 'completed') {
          pipelineStatus = 'needs-restore';
          if (slot && !slot.active) {
            const lagBytes = parseInt(slot.wal_lag_bytes || '0', 10);
            if (lagBytes > 100 * 1024 * 1024) {
              warnings.push(`Slot accumulating WAL: ${slot.wal_lag_pretty}`);
            }
          }
        } else if (!sub) {
          pipelineStatus = 'needs-subscription';
          if (slot && !slot.active) {
            const lagBytes = parseInt(slot.wal_lag_bytes || '0', 10);
            if (lagBytes > 100 * 1024 * 1024) {
              pipelineStatus = 'wal-accumulating';
              warnings.push(`Slot accumulating WAL: ${slot.wal_lag_pretty}`);
            }
          }
        } else if (!sub.enabled) {
          warnings.push('Subscription disabled');
        }
      }

      // Check for LSN gaps
      if (sub && slot && task.slot_initial_lsn) {
        // This is a simplified check - in reality we'd compare LSN values properly
        if (sub.data_copy === false && !slot.active) {
          warnings.push('Verify LSN alignment between backup and subscription');
        }
      }

      const tables = task.tables ? (typeof task.tables === 'string' ? JSON.parse(task.tables) : task.tables) : [];

      pipelines.push({
        id: task.id,
        name: task.service_name || task.filename || `Backup ${task.id.substring(0, 8)}`,
        type: 'backup',
        backup: {
          taskId: task.id,
          status: task.status,
          filename: task.filename,
          fileSize: task.file_size,
          tables,
          tableCount: tables.length,
          createdAt: task.created_at,
          completedAt: task.completed_at,
          serviceName: task.service_name,
        },
        publication: pub ? {
          name: pub.name,
          tableCount: parseInt(pub.table_count, 10),
          allTables: pub.all_tables,
        } : undefined,
        slot: slot ? {
          name: slot.name,
          restartLsn: slot.restart_lsn,
          confirmedFlushLsn: slot.confirmed_flush_lsn,
          walLagBytes: parseInt(slot.wal_lag_bytes || '0', 10),
          walLagPretty: slot.wal_lag_pretty || '0 bytes',
          active: slot.active,
        } : undefined,
        restore: restore ? {
          taskId: restore.id,
          status: restore.status,
          createdAt: restore.created_at,
          completedAt: restore.completed_at,
        } : undefined,
        subscription: sub ? {
          id: sub.id,
          name: sub.name,
          enabled: sub.enabled,
          dataCopy: sub.data_copy,
          createdAt: sub.created_at,
          status: sub.enabled ? 'active' : 'stopped',
          lagBytes: 0,
          lagSeconds: 0,
        } : undefined,
        pipelineStatus,
        warnings,
      });
    }

    // Add manual publications (not from backups)
    for (const pub of pubsResult.rows) {
      if (processedPubs.has(pub.name)) continue;
      if (pub.name.startsWith('backup_pub_')) continue; // Skip orphaned backup pubs without task

      const sub = subsByPubName.get(pub.name);
      const warnings: string[] = [];
      
      if (!pub.name.startsWith('backup_')) {
        warnings.push('Manual publication - no backup for gap-free replication');
      }

      pipelines.push({
        id: pub.name,
        name: pub.name,
        type: 'manual',
        publication: {
          name: pub.name,
          tableCount: parseInt(pub.table_count, 10),
          allTables: pub.all_tables,
        },
        subscription: sub ? {
          id: sub.id,
          name: sub.name,
          enabled: sub.enabled,
          dataCopy: sub.data_copy,
          createdAt: sub.created_at,
          status: sub.enabled ? 'active' : 'stopped',
          lagBytes: 0,
          lagSeconds: 0,
        } : undefined,
        pipelineStatus: sub ? 'complete' : 'needs-subscription',
        warnings,
      });
    }

    // Get running jobs count
    const runningJobs = backupTasksResult.rows.filter(t => 
      t.status === 'running' || t.status === 'pending'
    ).length + restoreTasksResult.rows.filter(t => 
      t.status === 'running' || t.status === 'pending'
    ).length;

    res.status(200).json({
      pipelines,
      summary: {
        total: pipelines.length,
        complete: pipelines.filter(p => p.pipelineStatus === 'complete').length,
        needsAction: pipelines.filter(p => ['needs-restore', 'needs-subscription', 'wal-accumulating'].includes(p.pipelineStatus)).length,
        running: pipelines.filter(p => p.pipelineStatus === 'running').length,
        errors: pipelines.filter(p => p.pipelineStatus === 'error').length,
        runningJobs,
      },
    });
  } catch (error: any) {
    console.error('[replication/pipelines] Error:', error);
    res.status(500).json({ error: 'Failed to load pipelines', details: error.message });
  } finally {
    if (sourcePool) await sourcePool.end();
  }
}
