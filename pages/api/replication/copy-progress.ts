import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';

interface SubscriptionProgress {
  subscriptionName: string;
  totalTables: number;
  tablesReady: number;
  tablesInitializing: number;
  tablesDone: number;
  tablesSyncing: number;
  percentComplete: number;
  status: 'complete' | 'in_progress' | 'ready' | 'unknown';
}

interface CopyProgressResponse {
  subscriptions: SubscriptionProgress[];
  overallProgress: {
    totalSubscriptions: number;
    completedSubscriptions: number;
    inProgressSubscriptions: number;
    totalTables: number;
    completedTables: number;
    percentComplete: number;
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let targetPool: Pool | null = null;

  try {
    // Get target database connection from monitoring DB
    const monitoringPool = new Pool({
      connectionString: process.env.MONITORING_DB_URL || 
        `postgresql://${process.env.MONITORING_DB_USER}:${process.env.MONITORING_DB_PASSWORD}@${process.env.MONITORING_DB_HOST}:${process.env.MONITORING_DB_PORT}/${process.env.MONITORING_DB_NAME}`
    });

    const subscriptions = await monitoringPool.query(`
      SELECT target_db_connection 
      FROM subscriptions 
      LIMIT 1
    `);

    await monitoringPool.end();

    if (subscriptions.rows.length === 0) {
      return res.status(200).json({
        subscriptions: [],
        overallProgress: {
          totalSubscriptions: 0,
          completedSubscriptions: 0,
          inProgressSubscriptions: 0,
          totalTables: 0,
          completedTables: 0,
          percentComplete: 0
        }
      });
    }

    // Connect to target database
    targetPool = new Pool({
      connectionString: subscriptions.rows[0].target_db_connection
    });

    // Get subscription copy progress
    const progressQuery = await targetPool.query(`
      SELECT 
        s.subname,
        COUNT(*) as total_tables,
        SUM(CASE WHEN sr.srsubstate = 'r' THEN 1 ELSE 0 END) as tables_ready,
        SUM(CASE WHEN sr.srsubstate = 'i' THEN 1 ELSE 0 END) as tables_initializing,
        SUM(CASE WHEN sr.srsubstate = 'd' THEN 1 ELSE 0 END) as tables_done,
        SUM(CASE WHEN sr.srsubstate = 's' THEN 1 ELSE 0 END) as tables_syncing
      FROM pg_subscription s
      LEFT JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
      GROUP BY s.subname
      ORDER BY s.subname
    `);

    const subscriptionProgress: SubscriptionProgress[] = progressQuery.rows.map(row => {
      const totalTables = parseInt(row.total_tables) || 0;
      const tablesReady = parseInt(row.tables_ready) || 0;
      const tablesInitializing = parseInt(row.tables_initializing) || 0;
      const tablesDone = parseInt(row.tables_done) || 0;
      const tablesSyncing = parseInt(row.tables_syncing) || 0;

      let status: 'complete' | 'in_progress' | 'ready' | 'unknown' = 'unknown';
      let percentComplete = 0;

      if (tablesDone === totalTables && totalTables > 0) {
        status = 'complete';
        percentComplete = 100;
      } else if (tablesInitializing > 0 || tablesSyncing > 0) {
        status = 'in_progress';
        percentComplete = totalTables > 0 ? (tablesDone / totalTables) * 100 : 0;
      } else if (tablesReady === totalTables && totalTables > 0) {
        status = 'ready';
        percentComplete = 0;
      }

      return {
        subscriptionName: row.subname,
        totalTables,
        tablesReady,
        tablesInitializing,
        tablesDone,
        tablesSyncing,
        percentComplete: Math.round(percentComplete * 10) / 10,
        status
      };
    });

    // Calculate overall progress
    const totalSubscriptions = subscriptionProgress.length;
    const completedSubscriptions = subscriptionProgress.filter(s => s.status === 'complete').length;
    const inProgressSubscriptions = subscriptionProgress.filter(s => s.status === 'in_progress').length;
    const totalTables = subscriptionProgress.reduce((sum, s) => sum + s.totalTables, 0);
    const completedTables = subscriptionProgress.reduce((sum, s) => sum + s.tablesDone, 0);
    const overallPercent = totalTables > 0 ? (completedTables / totalTables) * 100 : 0;

    const response: CopyProgressResponse = {
      subscriptions: subscriptionProgress,
      overallProgress: {
        totalSubscriptions,
        completedSubscriptions,
        inProgressSubscriptions,
        totalTables,
        completedTables,
        percentComplete: Math.round(overallPercent * 10) / 10
      }
    };

    res.status(200).json(response);
  } catch (error: any) {
    console.error('Error fetching copy progress:', error);
    res.status(500).json({ 
      error: 'Failed to fetch copy progress',
      details: error.message 
    });
  } finally {
    if (targetPool) {
      await targetPool.end();
    }
  }
}
