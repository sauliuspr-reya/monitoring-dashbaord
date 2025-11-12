import { Pool } from 'pg';

export interface ReplicationLogEntry {
  timestamp: Date;
  subscriptionName: string;
  level: 'info' | 'warning' | 'error';
  category: 'worker' | 'sync' | 'conflict' | 'error' | 'performance';
  message: string;
  details?: any;
  tableName?: string;
}

export class ReplicationLogsService {
  /**
   * Get subscription worker errors and status changes
   */
  async getSubscriptionWorkerLogs(
    targetPool: Pool,
    subscriptionName?: string,
    limit: number = 100
  ): Promise<ReplicationLogEntry[]> {
    const logs: ReplicationLogEntry[] = [];

    try {
      // Get current worker status
      const workerQuery = subscriptionName
        ? `SELECT * FROM pg_stat_subscription WHERE subname = $1`
        : `SELECT * FROM pg_stat_subscription`;
      
      const params = subscriptionName ? [subscriptionName] : [];
      const result = await targetPool.query(workerQuery, params);

      for (const row of result.rows) {
        const receivedLsn = row.received_lsn || '0/0';
        const latestEndLsn = row.latest_end_lsn || '0/0';
        
        // Check for worker issues
        if (!row.pid) {
          logs.push({
            timestamp: new Date(),
            subscriptionName: row.subname,
            level: 'error',
            category: 'worker',
            message: `Subscription worker is not running`,
            details: row
          });
        } else {
          logs.push({
            timestamp: new Date(),
            subscriptionName: row.subname,
            level: 'info',
            category: 'worker',
            message: `Worker running (PID: ${row.pid})`,
            details: {
              pid: row.pid,
              receivedLsn,
              latestEndLsn,
              latestEndTime: row.latest_end_time
            }
          });
        }

        // Check for replication lag
        if (row.latest_end_time) {
          const lagMs = Date.now() - new Date(row.latest_end_time).getTime();
          const lagSeconds = Math.floor(lagMs / 1000);
          
          if (lagSeconds > 60) {
            logs.push({
              timestamp: new Date(),
              subscriptionName: row.subname,
              level: 'warning',
              category: 'performance',
              message: `Replication lag detected: ${lagSeconds}s behind`,
              details: { lagSeconds, lastSync: row.latest_end_time }
            });
          }
        }
      }
    } catch (error: any) {
      console.error('Error fetching worker logs:', error);
      logs.push({
        timestamp: new Date(),
        subscriptionName: subscriptionName || 'all',
        level: 'error',
        category: 'error',
        message: `Failed to fetch worker status: ${error.message}`
      });
    }

    return logs;
  }

  /**
   * Get table sync status and errors
   */
  async getTableSyncLogs(
    targetPool: Pool,
    subscriptionName?: string,
    limit: number = 100
  ): Promise<ReplicationLogEntry[]> {
    const logs: ReplicationLogEntry[] = [];

    try {
      const query = subscriptionName
        ? `
          SELECT 
            sr.srsubstate::text as state,
            sr.srrelid::regclass::text as table_name,
            s.subname as subscription_name
          FROM pg_subscription_rel sr
          JOIN pg_subscription s ON s.oid = sr.srsubid
          WHERE s.subname = $1
          ORDER BY sr.srrelid
        `
        : `
          SELECT 
            sr.srsubstate::text as state,
            sr.srrelid::regclass::text as table_name,
            s.subname as subscription_name
          FROM pg_subscription_rel sr
          JOIN pg_subscription s ON s.oid = sr.srsubid
          ORDER BY s.subname, sr.srrelid
        `;

      const params = subscriptionName ? [subscriptionName] : [];
      const result = await targetPool.query(query, params);

      const stateCount: Record<string, { state: string; count: number }> = {};

      for (const row of result.rows) {
        const state = row.state;
        const tableName = row.table_name;
        const subName = row.subscription_name;

        // Count states per subscription
        const key = `${subName}_${state}`;
        if (!stateCount[key]) {
          stateCount[key] = { state, count: 0 };
        }
        stateCount[key].count++;

        // Log individual table issues
        if (state === 'i') {
          logs.push({
            timestamp: new Date(),
            subscriptionName: subName,
            level: 'info',
            category: 'sync',
            message: `Table "${tableName}" is initializing`,
            tableName,
            details: { state: 'initializing' }
          });
        } else if (state === 'd') {
          logs.push({
            timestamp: new Date(),
            subscriptionName: subName,
            level: 'info',
            category: 'sync',
            message: `Table "${tableName}" is copying data`,
            tableName,
            details: { state: 'data_copy' }
          });
        } else if (state === 's') {
          logs.push({
            timestamp: new Date(),
            subscriptionName: subName,
            level: 'info',
            category: 'sync',
            message: `Table "${tableName}" is synced`,
            tableName,
            details: { state: 'synced' }
          });
        } else if (state === 'r') {
          logs.push({
            timestamp: new Date(),
            subscriptionName: subName,
            level: 'info',
            category: 'sync',
            message: `Table "${tableName}" is ready`,
            tableName,
            details: { state: 'ready' }
          });
        }
      }

      // Add summary logs
      Object.entries(stateCount).forEach(([key, { state, count }]) => {
        const subName = key.replace(`_${state}`, '');
        const stateLabel = {
          'i': 'initializing',
          'd': 'copying data',
          's': 'synced',
          'r': 'ready'
        }[state] || state;

        logs.push({
          timestamp: new Date(),
          subscriptionName: subName,
          level: 'info',
          category: 'sync',
          message: `${count} table(s) ${stateLabel}`,
          details: { state, count }
        });
      });

    } catch (error: any) {
      console.error('Error fetching table sync logs:', error);
      logs.push({
        timestamp: new Date(),
        subscriptionName: subscriptionName || 'all',
        level: 'error',
        category: 'error',
        message: `Failed to fetch table sync status: ${error.message}`
      });
    }

    return logs;
  }

  /**
   * Get conflict logs from pg_stat_database_conflicts
   */
  async getConflictLogs(
    targetPool: Pool,
    limit: number = 100
  ): Promise<ReplicationLogEntry[]> {
    const logs: ReplicationLogEntry[] = [];

    try {
      const result = await targetPool.query(`
        SELECT 
          datname,
          confl_tablespace,
          confl_lock,
          confl_snapshot,
          confl_bufferpin,
          confl_deadlock
        FROM pg_stat_database_conflicts
        WHERE datname = current_database()
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        const totalConflicts = 
          (row.confl_tablespace || 0) +
          (row.confl_lock || 0) +
          (row.confl_snapshot || 0) +
          (row.confl_bufferpin || 0) +
          (row.confl_deadlock || 0);

        if (totalConflicts > 0) {
          logs.push({
            timestamp: new Date(),
            subscriptionName: 'system',
            level: 'warning',
            category: 'conflict',
            message: `${totalConflicts} total conflicts detected`,
            details: {
              tablespace: row.confl_tablespace,
              lock: row.confl_lock,
              snapshot: row.confl_snapshot,
              bufferpin: row.confl_bufferpin,
              deadlock: row.confl_deadlock
            }
          });
        }
      }
    } catch (error: any) {
      console.error('Error fetching conflict logs:', error);
    }

    return logs;
  }

  /**
   * Get recent errors from PostgreSQL logs (if logging_collector is enabled)
   */
  async getReplicationErrors(
    targetPool: Pool,
    subscriptionName?: string,
    hours: number = 24
  ): Promise<ReplicationLogEntry[]> {
    const logs: ReplicationLogEntry[] = [];

    try {
      // Check if pg_stat_statements is available for error tracking
      const extCheck = await targetPool.query(`
        SELECT EXISTS(
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
        ) as exists;
      `);

      if (extCheck.rows[0].exists) {
        const result = await targetPool.query(`
          SELECT 
            query,
            calls,
            mean_exec_time,
            stddev_exec_time
          FROM pg_stat_statements
          WHERE query LIKE '%ERROR%'
             OR query LIKE '%FATAL%'
             OR query LIKE '%PANIC%'
          ORDER BY calls DESC
          LIMIT 50
        `);

        for (const row of result.rows) {
          logs.push({
            timestamp: new Date(),
            subscriptionName: subscriptionName || 'unknown',
            level: 'error',
            category: 'error',
            message: `Query error detected (${row.calls} times)`,
            details: {
              query: row.query.substring(0, 200),
              calls: row.calls,
              avgTime: row.mean_exec_time
            }
          });
        }
      }
    } catch (error: any) {
      console.error('Error fetching replication errors:', error);
    }

    return logs;
  }

  /**
   * Get replication slot status from source database
   */
  async getReplicationSlotLogs(
    sourcePool: Pool,
    slotName?: string
  ): Promise<ReplicationLogEntry[]> {
    const logs: ReplicationLogEntry[] = [];

    try {
      const query = slotName
        ? `SELECT * FROM pg_replication_slots WHERE slot_name = $1`
        : `SELECT * FROM pg_replication_slots WHERE slot_type = 'logical'`;
      
      const params = slotName ? [slotName] : [];
      const result = await sourcePool.query(query, params);

      for (const row of result.rows) {
        if (!row.active) {
          logs.push({
            timestamp: new Date(),
            subscriptionName: row.slot_name,
            level: 'warning',
            category: 'worker',
            message: `Replication slot "${row.slot_name}" is inactive`,
            details: row
          });
        } else {
          logs.push({
            timestamp: new Date(),
            subscriptionName: row.slot_name,
            level: 'info',
            category: 'worker',
            message: `Replication slot "${row.slot_name}" is active`,
            details: {
              database: row.database,
              plugin: row.plugin,
              active: row.active
            }
          });
        }

        // Check for WAL retention issues
        if (row.wal_status === 'lost') {
          logs.push({
            timestamp: new Date(),
            subscriptionName: row.slot_name,
            level: 'error',
            category: 'error',
            message: `WAL files lost for slot "${row.slot_name}"`,
            details: { walStatus: row.wal_status }
          });
        }
      }
    } catch (error: any) {
      console.error('Error fetching replication slot logs:', error);
    }

    return logs;
  }

  /**
   * Get all logs combined and sorted
   */
  async getAllLogs(
    sourcePool: Pool,
    targetPool: Pool,
    subscriptionName?: string,
    limit: number = 200
  ): Promise<ReplicationLogEntry[]> {
    const [
      workerLogs,
      syncLogs,
      conflictLogs,
      errorLogs,
      slotLogs
    ] = await Promise.all([
      this.getSubscriptionWorkerLogs(targetPool, subscriptionName),
      this.getTableSyncLogs(targetPool, subscriptionName),
      this.getConflictLogs(targetPool),
      this.getReplicationErrors(targetPool, subscriptionName),
      this.getReplicationSlotLogs(sourcePool, subscriptionName)
    ]);

    const allLogs = [
      ...workerLogs,
      ...syncLogs,
      ...conflictLogs,
      ...errorLogs,
      ...slotLogs
    ];

    // Sort by timestamp descending
    allLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return allLogs.slice(0, limit);
  }
}
