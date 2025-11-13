import type { NextApiRequest, NextApiResponse } from 'next';
import { TABLE_GROUPS } from '@/lib/table-groups';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const { subscriptionId } = req.query;

    // If subscriptionId is provided, get tables from existing subscription
    if (subscriptionId) {
      const pool = getDbPool();
      const result = await pool.query(`
        SELECT * FROM subscriptions WHERE id = $1
      `, [subscriptionId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Subscription not found' });
      }

      const subscription = result.rows[0];
      const sourcePool = createSourceTargetPool(subscription.source_db_connection);

      try {
        // Get actual tables from the publication
        const tablesResult = await sourcePool.query(`
          SELECT schemaname || '.' || tablename as table_name
          FROM pg_publication_tables
          WHERE pubname = $1
          ORDER BY tablename
        `, [subscription.publication_name]);

        const existingTables = tablesResult.rows.map((r: any) => r.table_name);

        // Map to groups
        const groupsWithTables = TABLE_GROUPS.map(group => ({
          ...group,
          tables: group.tables.filter(t => existingTables.includes(`public.${t}`)),
          allTablesInGroup: group.tables,
        }));

        return res.status(200).json({
          groups: groupsWithTables,
          existingTables,
        });
      } finally {
        await sourcePool.end();
      }
    }

    // Return all available table groups
    const groupsWithInfo = TABLE_GROUPS.map(group => ({
      name: group.name,
      description: group.description,
      priority: group.priority,
      tableCount: group.tables.length,
      tables: group.tables,
      suggestedPublicationName: `reya_${group.name}_publication`,
      suggestedSubscriptionName: `reya_${group.name}_subscription`,
      suggestedSlotName: `reya_${group.name}_slot`,
    }));

    res.status(200).json({
      groups: groupsWithInfo,
      totalGroups: groupsWithInfo.length,
      totalTables: TABLE_GROUPS.reduce((sum, g) => sum + g.tables.length, 0),
    });
  } catch (error: any) {
    console.error('Error getting table groups:', error);
    res.status(500).json({ error: error.message || 'Failed to get table groups' });
  }
}

