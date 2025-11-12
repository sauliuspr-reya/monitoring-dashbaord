import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;
  const { action, tables } = req.body;

  if (!id || !action || !tables || !Array.isArray(tables)) {
    return res.status(400).json({ 
      error: 'Missing required fields: action (add|remove), tables (array)' 
    });
  }

  if (!['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'Action must be "add" or "remove"' });
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
    const targetPool = createSourceTargetPool(subscription.target_db_connection);

    try {
      const publicationName = subscription.publication_name;
      const subscriptionName = subscription.subscription_name;

      // Validate tables exist
      const tableCheckResult = await sourcePool.query(`
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = ANY($1::text[])
      `, [tables]);

      const existingTables = tableCheckResult.rows.map(r => r.tablename);
      const missingTables = tables.filter(t => !existingTables.includes(t));

      if (missingTables.length > 0) {
        return res.status(400).json({ 
          error: `Tables not found in source database: ${missingTables.join(', ')}` 
        });
      }

      // Check if tables are already in other publications (for add action)
      if (action === 'add') {
        const duplicateCheck = await sourcePool.query(`
          SELECT pt.tablename, pt.pubname
          FROM pg_publication_tables pt
          WHERE pt.tablename = ANY($1::text[])
          AND pt.pubname != $2
        `, [tables, publicationName]);

        if (duplicateCheck.rows.length > 0) {
          const conflicts = duplicateCheck.rows.map(r => `${r.tablename} (in ${r.pubname})`);
          return res.status(400).json({
            error: `Tables already in other publications: ${conflicts.join(', ')}`,
            conflicts: duplicateCheck.rows
          });
        }
      }

      // Modify the publication
      const tableList = tables.map(t => `public."${t}"`).join(', ');

      if (action === 'add') {
        await sourcePool.query(`
          ALTER PUBLICATION ${publicationName} ADD TABLE ${tableList}
        `);
      } else {
        await sourcePool.query(`
          ALTER PUBLICATION ${publicationName} DROP TABLE ${tableList}
        `);
      }

      // Refresh the subscription to pick up changes
      await targetPool.query(`
        ALTER SUBSCRIPTION ${subscriptionName} REFRESH PUBLICATION
      `);

      // Get updated table count
      const countResult = await sourcePool.query(`
        SELECT COUNT(*) as count
        FROM pg_publication_tables
        WHERE pubname = $1
      `, [publicationName]);

      res.status(200).json({
        success: true,
        action,
        tables,
        publication: publicationName,
        subscription: subscriptionName,
        tableCount: parseInt(countResult.rows[0].count, 10),
        message: `${action === 'add' ? 'Added' : 'Removed'} ${tables.length} table(s) ${action === 'add' ? 'to' : 'from'} ${publicationName}`
      });

    } finally {
      await sourcePool.end();
      await targetPool.end();
    }

  } catch (error: any) {
    console.error('Error modifying subscription tables:', error);
    res.status(500).json({ 
      error: 'Failed to modify subscription tables',
      details: error.message 
    });
  }
}
