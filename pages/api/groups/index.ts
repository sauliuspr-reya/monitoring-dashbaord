import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool } from '@/lib/db/connection';
import { ReplicationGroup } from '@/lib/types';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    try {
      const pool = getDbPool();
      
      // Test connection first
      await pool.query('SELECT 1');
      
      const result = await pool.query(`
        SELECT * FROM subscriptions
        ORDER BY created_at DESC
      `);

      const groups: ReplicationGroup[] = result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        sourceDbConnection: row.source_db_connection,
        targetDbConnection: row.target_db_connection,
        publicationName: row.publication_name,
        subscriptionName: row.subscription_name,
        slotName: row.slot_name,
        enabled: row.enabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      res.status(200).json(groups);
    } catch (error) {
      console.error('Error fetching groups:', error);
      res.status(500).json({ error: 'Failed to fetch groups' });
    }
  } else if (req.method === 'POST') {
    try {
      const {
        name,
        description,
        sourceDbConnection,
        targetDbConnection,
        publicationName,
        subscriptionName,
        slotName,
        enabled = true,
      } = req.body;

      if (!name || !sourceDbConnection || !targetDbConnection || !publicationName || !subscriptionName || !slotName) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const pool = getDbPool();
      const result = await pool.query(`
        INSERT INTO subscriptions (
          name, description, source_db_connection, target_db_connection,
          publication_name, subscription_name, slot_name, enabled
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        name,
        description,
        sourceDbConnection,
        targetDbConnection,
        publicationName,
        subscriptionName,
        slotName,
        enabled,
      ]);

      const group: ReplicationGroup = {
        id: result.rows[0].id,
        name: result.rows[0].name,
        description: result.rows[0].description,
        sourceDbConnection: result.rows[0].source_db_connection,
        targetDbConnection: result.rows[0].target_db_connection,
        publicationName: result.rows[0].publication_name,
        subscriptionName: result.rows[0].subscription_name,
        slotName: result.rows[0].slot_name,
        enabled: result.rows[0].enabled,
        createdAt: result.rows[0].created_at,
        updatedAt: result.rows[0].updated_at,
      };

      res.status(201).json(group);
    } catch (error) {
      console.error('Error creating group:', error);
      res.status(500).json({ error: 'Failed to create group' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
}

