import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { GCPLogsService } from '@/lib/services/gcp-logs.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;
  const hours = parseInt(req.query.hours as string) || 24;

  try {
    const pool = getDbPool();
    
    // Get subscription details (support both old and new table names)
    const groupResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [id]).catch(() => 
      pool.query(`
        SELECT * FROM replication_groups WHERE id = $1
      `, [id])
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const group = groupResult.rows[0];
    const targetPool = createSourceTargetPool(group.target_db_connection);

    try {
      // Query PostgreSQL logs from the target database
      const logs: any[] = [];

      // Check pg_stat_activity for errors
      const activityResult = await targetPool.query(`
        SELECT 
          pid,
          application_name,
          state,
          query,
          state_change,
          wait_event_type,
          wait_event
        FROM pg_stat_activity
        WHERE application_name LIKE '%${group.subscription_name}%'
           OR query LIKE '%${group.subscription_name}%'
           OR state = 'idle in transaction (aborted)'
        ORDER BY state_change DESC
        LIMIT 50;
      `);

      for (const row of activityResult.rows) {
        if (row.state === 'idle in transaction (aborted)') {
          logs.push({
            type: 'aborted_transaction',
            timestamp: row.state_change,
            message: `Aborted transaction in ${row.application_name}`,
            query: row.query?.substring(0, 200),
            pid: row.pid,
          });
        }
      }

      // Check pg_subscription_rel for error states
      const subscriptionRelResult = await targetPool.query(`
        SELECT 
          srrelid::regclass as table_name,
          srsubstate,
          srsublsn
        FROM pg_subscription_rel
        WHERE srsubid = (
          SELECT oid FROM pg_subscription WHERE subname = $1
        )
        AND srsubstate = 'e'
        ORDER BY srrelid;
      `, [group.subscription_name]);

      for (const row of subscriptionRelResult.rows) {
        logs.push({
          type: 'table_error',
          timestamp: new Date(),
          message: `Table ${row.table_name} is in error state`,
          tableName: row.table_name,
          state: row.srsubstate,
        });
      }

      // Check pg_stat_statements for errors (if extension is enabled)
      try {
        const statementsResult = await targetPool.query(`
          SELECT 
            query,
            calls,
            total_exec_time,
            mean_exec_time
          FROM pg_stat_statements
          WHERE query LIKE '%duplicate key%'
             OR query LIKE '%violates unique constraint%'
             OR query LIKE '%primary key%'
          ORDER BY calls DESC
          LIMIT 20;
        `);

        for (const row of statementsResult.rows) {
          logs.push({
            type: 'error_query',
            timestamp: new Date(),
            message: 'Query with potential PK conflict',
            query: row.query?.substring(0, 300),
            calls: row.calls,
          });
        }
      } catch (err: any) {
        // pg_stat_statements might not be enabled
        if (!err.message.includes('does not exist')) {
          console.warn('Error querying pg_stat_statements:', err);
        }
      }

      // Query GCP Cloud Logging if configured
      const gcpLogsService = new GCPLogsService();
      const gcpConflicts = await gcpLogsService.queryConflictsFromGCPLogs({
        start: new Date(Date.now() - hours * 60 * 60 * 1000),
        end: new Date(),
      });

      for (const conflict of gcpConflicts) {
        logs.push({
          type: 'gcp_log_conflict',
          timestamp: conflict.timestamp,
          message: `PK conflict in ${conflict.tableName}: ${conflict.errorMessage}`,
          tableName: conflict.tableName,
          primaryKey: conflict.primaryKey,
          keyValue: conflict.keyValue,
          severity: conflict.severity,
        });
      }

      // Sort by timestamp
      logs.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      res.status(200).json({ logs });
    } finally {
      await targetPool.end();
    }
  } catch (error: any) {
    console.error('Error getting logs:', error);
    res.status(500).json({ error: error.message || 'Failed to get logs' });
  }
}

