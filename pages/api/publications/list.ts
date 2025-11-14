import type { NextApiRequest, NextApiResponse } from 'next';
import { createSourceTargetPool, getDbPool } from '@/lib/db/connection';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const { sourceDbConnection } = req.query;

    // Use provided connection or fall back to environment variable
    const finalSourceConnection = (sourceDbConnection && typeof sourceDbConnection === 'string' && sourceDbConnection.trim() !== '') 
      ? sourceDbConnection 
      : (process.env.SOURCE_DATABASE_URL || '');

    if (!finalSourceConnection || finalSourceConnection.trim() === '') {
      return res.status(400).json({
        error: 'Source database connection string is required',
        details: 'Please set SOURCE_DATABASE_URL environment variable or provide sourceDbConnection query parameter.',
      });
    }

    const sourcePool = createSourceTargetPool(finalSourceConnection);

    try {
      // Get all publications
      const publicationsResult = await sourcePool.query(`
        SELECT 
          pubname AS name,
          puballtables AS all_tables,
          pubinsert AS insert_enabled,
          pubupdate AS update_enabled,
          pubdelete AS delete_enabled,
          pubtruncate AS truncate_enabled
        FROM pg_publication
        ORDER BY pubname
      `);

      if (publicationsResult.rows.length === 0) {
        return res.status(200).json({ publications: [] });
      }

      // Get monitoring database pool to check for backup tasks
      const monitoringPool = getDbPool();

      // Get tables for each publication
      const publications = await Promise.all(
        publicationsResult.rows.map(async (pub) => {
          let tables: string[] = [];
          
          if (pub.all_tables) {
            // If publication is for all tables, get all tables from the database
            const allTablesResult = await sourcePool.query(`
              SELECT schemaname || '.' || tablename AS table_name
              FROM pg_tables
              WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
              ORDER BY schemaname, tablename
            `);
            tables = allTablesResult.rows.map((r: any) => r.table_name);
          } else {
            // Get specific tables in the publication
            const tablesResult = await sourcePool.query(`
              SELECT schemaname || '.' || tablename AS table_name
              FROM pg_publication_tables
              WHERE pubname = $1
              ORDER BY schemaname, tablename
            `, [pub.name]);
            tables = tablesResult.rows.map((r: any) => r.table_name);
          }

          // Find backup task that created this publication
          let taskId: string | null = null;
          let createdAt: string | null = null;
          try {
            const taskResult = await monitoringPool.query(`
              SELECT id, created_at
              FROM backup_tasks
              WHERE publication_name = $1
              ORDER BY created_at DESC
              LIMIT 1
            `, [pub.name]);
            
            if (taskResult.rows.length > 0) {
              taskId = taskResult.rows[0].id;
              createdAt = taskResult.rows[0].created_at;
            }
          } catch (err) {
            // Ignore errors - monitoring DB might not be available
            console.warn('[publications/list] Could not query backup_tasks:', err);
          }

          return {
            name: pub.name,
            allTables: pub.all_tables,
            insertEnabled: pub.insert_enabled,
            updateEnabled: pub.update_enabled,
            deleteEnabled: pub.delete_enabled,
            truncateEnabled: pub.truncate_enabled,
            tables,
            tableCount: tables.length,
            taskId,
            createdAt,
          };
        })
      );

      res.status(200).json({ publications });
    } finally {
      await sourcePool.end();
    }
  } catch (error: any) {
    console.error('[publications/list] Error:', error);
    res.status(500).json({
      error: 'Failed to list publications',
      message: error.message,
      details: error.detail || error.message,
    });
  }
}

