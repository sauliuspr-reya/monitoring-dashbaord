import { Pool } from 'pg';
import { ReplicationStatus, TableStatus } from '../types';
import { createSourceTargetPool, retryQuery } from '../db/connection';

export class MonitoringService {
  /**
   * Get replication status for a group
   */
  async getReplicationStatus(
    sourcePool: Pool,
    targetPool: Pool,
    subscriptionName: string,
    slotName: string
  ): Promise<Partial<ReplicationStatus>> {
    const status: Partial<ReplicationStatus> = {
      subscriptionEnabled: false,
      workerRunning: false,
      lagBytes: 0,
      lagSeconds: 0,
      slotLagBytes: 0,
      status: 'stopped',
    };

    try {
      // Check subscription status on target (with retry)
      const subResult = await retryQuery(() => targetPool.query(`
        SELECT 
          s.subenabled as enabled,
          ss.pid as worker_pid,
          ss.latest_end_lsn,
          ss.latest_end_time
        FROM pg_subscription s
        LEFT JOIN pg_stat_subscription ss ON s.subname = ss.subname
        WHERE s.subname = $1
      `, [subscriptionName]));

      if (subResult.rows.length > 0) {
        const sub = subResult.rows[0];
        status.subscriptionEnabled = sub.enabled;
        status.workerRunning = sub.worker_pid !== null;
        status.lastAppliedAt = sub.latest_end_time;
      }

      // Check replication slot lag on source (with retry)
      const slotResult = await retryQuery(() => sourcePool.query(`
        SELECT 
          active,
          pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as slot_lag_bytes,
          restart_lsn,
          confirmed_flush_lsn
        FROM pg_replication_slots
        WHERE slot_name = $1
      `, [slotName]));

      if (slotResult.rows.length > 0) {
        const slot = slotResult.rows[0];
        status.slotLagBytes = parseInt(slot.slot_lag_bytes || '0', 10);
      }

      // Check replication connection lag on source (with retry)
      const replResult = await retryQuery(() => sourcePool.query(`
        SELECT 
          state,
          sync_state,
          pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn) as lag_bytes,
          EXTRACT(EPOCH FROM (now() - write_lag))::int as lag_seconds
        FROM pg_stat_replication
        WHERE application_name = $1
      `, [subscriptionName]));

      if (replResult.rows.length > 0) {
        const repl = replResult.rows[0];
        status.lagBytes = parseInt(repl.lag_bytes || '0', 10);
        status.lagSeconds = repl.lag_seconds || 0;
        status.status = repl.state === 'streaming' ? 'active' : 'stopped';
      } else if (status.subscriptionEnabled && !status.workerRunning) {
        status.status = 'error';
      }

      return status;
    } catch (error) {
      console.error('Error getting replication status:', error);
      status.status = 'error';
      return status;
    }
  }

  /**
   * Get table-level status
   */
  async getTableStatus(
    sourcePool: Pool,
    targetPool: Pool,
    tableName: string,
    schemaName: string = 'public'
  ): Promise<Partial<TableStatus>> {
    const status: Partial<TableStatus> = {
      tableName,
      sourceRowCount: 0,
      targetRowCount: 0,
      gapSize: 0,
      status: 'synced',
      hasConflict: false,
    };

    try {
      // OPTIMIZATION: Use pg_stat_user_tables.n_live_tup (more accurate) or reltuples (fallback)
      // n_live_tup is updated by autovacuum and is more accurate than reltuples
      // COUNT(*) is too expensive on large tables and kills database performance
      const [sourceResult, targetResult] = await Promise.all([
        sourcePool.query(`
          SELECT COALESCE(s.n_live_tup::bigint, c.reltuples::bigint, 0) as estimate
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid AND s.schemaname = n.nspname
          WHERE c.relname = $1 
            AND n.nspname = $2
        `, [tableName, schemaName]),
        targetPool.query(`
          SELECT COALESCE(s.n_live_tup::bigint, c.reltuples::bigint, 0) as estimate
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid AND s.schemaname = n.nspname
          WHERE c.relname = $1 
            AND n.nspname = $2
        `, [tableName, schemaName]).catch(() => ({ rows: [{ estimate: '0' }] })),
      ]);

      status.sourceRowCount = parseInt(sourceResult.rows[0]?.estimate || '0', 10);
      status.targetRowCount = parseInt(targetResult.rows[0]?.estimate || '0', 10);
      status.gapSize = status.sourceRowCount - status.targetRowCount;

      // Determine status
      if (status.gapSize === 0) {
        status.status = 'synced';
      } else if (Math.abs(status.gapSize) < 100) {
        status.status = 'lagging';
      } else {
        status.status = 'error';
      }

      return status;
    } catch (error) {
      console.error(`Error getting table status for ${tableName}:`, error);
      status.status = 'error';
      return status;
    }
  }

  /**
   * Get all tables in a publication
   */
  async getPublicationTables(
    sourcePool: Pool,
    publicationName: string
  ): Promise<string[]> {
    try {
      const result = await sourcePool.query(`
        SELECT schemaname, tablename
        FROM pg_publication_tables
        WHERE pubname = $1
        ORDER BY schemaname, tablename
      `, [publicationName]);

      return result.rows.map(
        (row) => `${row.schemaname}."${row.tablename}"`
      );
    } catch (error) {
      console.error('Error getting publication tables:', error);
      return [];
    }
  }
}

