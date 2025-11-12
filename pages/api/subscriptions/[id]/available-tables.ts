import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Subscription ID is required' });
  }

  try {
    const pool = getDbPool();
    
    // Get subscription details
    const subResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [id]);

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const subscription = subResult.rows[0];
    const sourcePool = createSourceTargetPool(subscription.source_db_connection);

    try {
      const publicationName = subscription.publication_name;

      // Get all tables in source database
      const allTablesResult = await sourcePool.query(`
        SELECT 
          t.tablename,
          pg_size_pretty(pg_total_relation_size(c.oid)) as size,
          pg_total_relation_size(c.oid) as size_bytes
        FROM pg_tables t
        JOIN pg_class c ON c.relname = t.tablename
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
        WHERE t.schemaname = 'public'
        ORDER BY pg_total_relation_size(c.oid) DESC
      `);

      // Get tables currently in this publication
      const currentTablesResult = await sourcePool.query(`
        SELECT tablename
        FROM pg_publication_tables
        WHERE pubname = $1
      `, [publicationName]);

      const currentTables = new Set(currentTablesResult.rows.map(r => r.tablename));

      // Get tables in OTHER publications
      const otherTablesResult = await sourcePool.query(`
        SELECT tablename, pubname
        FROM pg_publication_tables
        WHERE pubname != $1
      `, [publicationName]);

      const otherTables = new Map<string, string>();
      otherTablesResult.rows.forEach(r => {
        otherTables.set(r.tablename, r.pubname);
      });

      // Categorize tables
      const tables = allTablesResult.rows.map(row => ({
        name: row.tablename,
        size: row.size,
        sizeBytes: parseInt(row.size_bytes, 10),
        status: currentTables.has(row.tablename) 
          ? 'in-publication' 
          : otherTables.has(row.tablename)
          ? 'in-other-publication'
          : 'available',
        currentPublication: currentTables.has(row.tablename) ? publicationName : otherTables.get(row.tablename) || null
      }));

      const summary = {
        totalTables: tables.length,
        inPublication: tables.filter(t => t.status === 'in-publication').length,
        available: tables.filter(t => t.status === 'available').length,
        inOther: tables.filter(t => t.status === 'in-other-publication').length
      };

      res.status(200).json({
        tables,
        summary,
        publication: publicationName
      });

    } finally {
      await sourcePool.end();
    }

  } catch (error: any) {
    console.error('Error fetching available tables:', error);
    res.status(500).json({ 
      error: 'Failed to fetch available tables',
      details: error.message 
    });
  }
}
