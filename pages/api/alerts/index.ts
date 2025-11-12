import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool } from '@/lib/db/connection';
import { Alert } from '@/lib/types';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    try {
      const { groupId, acknowledged } = req.query;
      const pool = getDbPool();

      let query = 'SELECT * FROM alerts WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (groupId) {
        query += ` AND group_id = $${paramIndex}`;
        params.push(groupId);
        paramIndex++;
      }

      if (acknowledged !== undefined) {
        query += ` AND acknowledged = $${paramIndex}`;
        params.push(acknowledged === 'true');
        paramIndex++;
      }

      query += ' ORDER BY created_at DESC LIMIT 100';

      const result = await pool.query(query, params);
      const alerts: Alert[] = result.rows.map((row) => ({
        id: row.id,
        groupId: row.group_id,
        tableName: row.table_name,
        alertType: row.alert_type,
        message: row.message,
        severity: row.severity,
        acknowledged: row.acknowledged,
        acknowledgedAt: row.acknowledged_at,
        acknowledgedBy: row.acknowledged_by,
        createdAt: row.created_at,
      }));

      res.status(200).json(alerts);
    } catch (error) {
      console.error('Error fetching alerts:', error);
      res.status(500).json({ error: 'Failed to fetch alerts' });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
}

