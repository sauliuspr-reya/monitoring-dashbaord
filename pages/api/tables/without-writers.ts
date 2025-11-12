import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { ApplicationTrackingService } from '@/lib/services/application-tracking.service';
import { GoldskyAnalysisService } from '@/lib/services/goldsky-analysis.service';

interface TableWithoutWriter {
  tableName: string;
  schema: string;
  table: string;
  reason: 'no_writers' | 'read_only' | 'replication_only';
  existingSubscription?: string;
  isGoldsky?: boolean;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const pool = getDbPool();
    
    // Get all subscriptions to check which tables are already subscribed
    const subscriptionsResult = await pool.query(`
      SELECT id, name, publication_name, source_db_connection, target_db_connection
      FROM subscriptions
      ORDER BY name
    `).catch(() =>
      pool.query(`
        SELECT id, name, publication_name, source_db_connection, target_db_connection
        FROM replication_groups
        ORDER BY name
      `)
    );

    const subscriptions = subscriptionsResult.rows;

    if (subscriptions.length === 0) {
      return res.status(200).json({ 
        tables: [],
        totalTables: 0,
        message: 'No subscriptions found. Please create at least one subscription first to get connection strings.'
      });
    }

    const firstSub = subscriptions[0];
    const sourcePool = createSourceTargetPool(firstSub.source_db_connection);
    const targetPool = createSourceTargetPool(firstSub.target_db_connection);

    try {
      // Get all tables from source database
      const allTablesResult = await sourcePool.query(`
        SELECT 
          schemaname || '.' || tablename as table_name,
          schemaname,
          tablename
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);

      // Get tables that are being written to by services
      const appTrackingService = new ApplicationTrackingService();
      const writeStats = await appTrackingService.getWriteStatsByApplication(sourcePool, 24).catch(() => []);
      const tablesWithWriters = new Set(writeStats.map(s => s.table));

      // Get Goldsky tables (exclude these)
      const goldskyService = new GoldskyAnalysisService();
      const goldskyTables = await goldskyService.getGoldskyTables().catch(() => new Set<string>());

      // Get tables already in subscriptions
      const subscribedTables = new Set<string>();
      for (const sub of subscriptions) {
        const subSourcePool = createSourceTargetPool(sub.source_db_connection);
        try {
          const pubTablesResult = await subSourcePool.query(`
            SELECT schemaname || '.' || tablename as table_name
            FROM pg_publication_tables
            WHERE pubname = $1
          `, [sub.publication_name]).catch(() => ({ rows: [] }));
          
          for (const row of pubTablesResult.rows) {
            const [schema, table] = row.table_name.split('.');
            subscribedTables.add(table);
          }
        } finally {
          await subSourcePool.end();
        }
      }

      // Identify tables without writers
      const tablesWithoutWriters: TableWithoutWriter[] = [];

      for (const row of allTablesResult.rows) {
        const [schema, table] = row.table_name.split('.');
        const isGoldsky = goldskyTables.has(table);
        const hasWriters = tablesWithWriters.has(table);
        const isSubscribed = subscribedTables.has(table);

        // Skip Goldsky tables (they shouldn't be replicated)
        if (isGoldsky) {
          continue;
        }

        // Include tables that:
        // 1. Don't have active writers (not being written to by services)
        // 2. Are not already in subscriptions
        if (!hasWriters && !isSubscribed) {
          tablesWithoutWriters.push({
            tableName: row.table_name,
            schema: row.schemaname,
            table: row.tablename,
            reason: 'no_writers',
            isGoldsky: false,
          });
        }
      }

      res.status(200).json({
        tables: tablesWithoutWriters,
        totalTables: tablesWithoutWriters.length,
        stats: {
          totalTablesInDb: allTablesResult.rows.length,
          tablesWithWriters: tablesWithWriters.size,
          tablesInSubscriptions: subscribedTables.size,
          goldskyTables: goldskyTables.size,
          tablesWithoutWriters: tablesWithoutWriters.length,
        },
      });
    } finally {
      await sourcePool.end();
      await targetPool.end();
    }
  } catch (error: any) {
    console.error('Error getting tables without writers:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to get tables without writers',
      details: error.detail,
    });
  }
}

