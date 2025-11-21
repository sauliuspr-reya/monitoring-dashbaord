import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool, retryQuery } from '@/lib/db/connection';
import { MonitoringService } from '@/lib/services/monitoring.service';
import { ConflictDetectionService } from '@/lib/services/conflict-detection.service';
import { AlertingService } from '@/lib/services/alerting.service';
import { ReplicationStatus } from '@/lib/types';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;

  try {
    const pool = getDbPool();

    // Get subscription details
    const groupResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [id]);

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const group = groupResult.rows[0];

    // Create connection pools for source and target
    const sourcePool = createSourceTargetPool(group.source_db_connection);
    const targetPool = createSourceTargetPool(group.target_db_connection);

    try {
      const monitoringService = new MonitoringService();
      const conflictService = new ConflictDetectionService();
      const alertingService = new AlertingService();

      // Get replication status (with retry for connection errors)
      const status = await retryQuery(() =>
        monitoringService.getReplicationStatus(
          sourcePool,
          targetPool,
          group.subscription_name,
          group.slot_name
        ),
        3, // max retries
        1000 // initial delay
      );

      // Get table count (with retry)
      const tablesResult = await retryQuery(() =>
        monitoringService.getPublicationTables(
          sourcePool,
          group.publication_name
        )
      );

      // Get conflicts
      const conflicts = await conflictService.getUnresolvedConflicts(group.id);

      // Get table-level metrics (optional - skip if includeTables=false to avoid expensive queries)
      // Only query if explicitly requested (for backward compatibility, default to true)
      const includeTables = req.query.includeTables !== 'false';
      let tablesWithIssues = 0;

      if (includeTables) {
        // Get table-level metrics (check which column exists)
        const metricsColumnCheck = await pool.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'table_replication_metrics' 
            AND column_name IN ('subscription_id', 'group_id')
          LIMIT 1
        `);

        const metricsIdColumn = metricsColumnCheck.rows[0]?.column_name || 'subscription_id';

        const tableMetricsResult = await pool.query(`
          SELECT 
            table_name,
            source_row_count,
            target_row_count,
            gap_size,
            status,
            last_replicated_at
          FROM table_replication_metrics
          WHERE ${metricsIdColumn} = $1
            AND timestamp > NOW() - INTERVAL '1 hour'
          ORDER BY timestamp DESC
        `, [group.id]);

        // Count tables with REAL issues (only errors and warnings, not lagging)
        // "lagging" is normal during replication - it's not an error
        tablesWithIssues = tableMetricsResult.rows.filter(
          (row) => row.status === 'error' || row.status === 'warning'
        ).length;
      }

      const fullStatus: ReplicationStatus = {
        subscriptionId: group.id,
        subscriptionName: group.name,
        // Legacy fields for backward compatibility
        groupId: group.id,
        groupName: group.name,
        enabled: group.enabled,
        subscriptionEnabled: status.subscriptionEnabled || false,
        workerRunning: status.workerRunning || false,
        workerPid: status.workerPid,
        workerState: status.workerState,
        workerSyncState: status.workerSyncState,
        workerReceivedLsn: status.workerReceivedLsn,
        workerLatestEndLsn: status.workerLatestEndLsn,
        workerLastMsgSendTime: status.workerLastMsgSendTime,
        workerLastMsgReceiptTime: status.workerLastMsgReceiptTime,
        workerWriteLag: status.workerWriteLag,
        workerFlushLag: status.workerFlushLag,
        workerReplayLag: status.workerReplayLag,
        lagBytes: status.lagBytes || 0,
        lagSeconds: status.lagSeconds || 0,
        slotLagBytes: status.slotLagBytes || 0,
        slotName: group.slot_name,
        slotActive: status.slotActive,
        slotInitialLsn: group.slot_initial_lsn,
        slotRestartLsn: status.slotRestartLsn,
        slotConfirmedFlushLsn: status.slotConfirmedFlushLsn,
        slotWalStatus: status.slotWalStatus,
        status: status.status || 'stopped',
        lastAppliedAt: status.lastAppliedAt,
        lastAppliedLsn: status.lastAppliedLsn,
        replicationState: status.replicationState,
        replicationSyncState: status.replicationSyncState,
        replicationClientAddr: status.replicationClientAddr,
        replicationSentLsn: status.replicationSentLsn,
        replicationWriteLsn: status.replicationWriteLsn,
        replicationFlushLsn: status.replicationFlushLsn,
        replicationReplayLsn: status.replicationReplayLsn,
        tableCount: tablesResult.length,
        tablesWithIssues,
        conflicts: conflicts.length,
        dataCopy: group.data_copy || false,
        publicationName: group.publication_name,
        subscriptionDbName: group.subscription_name,
      };

      // Check and create alerts if needed
      await alertingService.checkAndAlert(
        group.id,
        group.name,
        {
          lagBytes: fullStatus.lagBytes,
          lagSeconds: fullStatus.lagSeconds,
          slotLagBytes: fullStatus.slotLagBytes,
          status: fullStatus.status,
          hasConflict: conflicts.length > 0,
        }
      );

      res.status(200).json(fullStatus);
    } finally {
      await sourcePool.end();
      await targetPool.end();
    }
  } catch (error) {
    console.error('Error getting group status:', error);
    res.status(500).json({ error: 'Failed to get group status' });
  }
}

