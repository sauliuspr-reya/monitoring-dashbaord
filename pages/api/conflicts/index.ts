import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool } from '@/lib/db/connection';
import { ConflictDetection } from '@/lib/types';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    try {
      const { groupId, resolved } = req.query;
      const pool = getDbPool();

      let query = 'SELECT * FROM conflict_detections WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (groupId) {
        query += ` AND group_id = $${paramIndex}`;
        params.push(groupId);
        paramIndex++;
      }

      if (resolved === 'false') {
        query += ` AND resolved_at IS NULL`;
      } else if (resolved === 'true') {
        query += ` AND resolved_at IS NOT NULL`;
      }

      query += ' ORDER BY detected_at DESC LIMIT 100';

      const result = await pool.query(query, params);
      const conflicts: ConflictDetection[] = result.rows.map((row) => ({
        id: row.id,
        groupId: row.group_id,
        tableName: row.table_name,
        errorMessage: row.error_message,
        errorType: row.error_type,
        detectedAt: row.detected_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        resolutionNotes: row.resolution_notes,
        severity: row.severity,
      }));

      res.status(200).json(conflicts);
    } catch (error) {
      console.error('Error fetching conflicts:', error);
      res.status(500).json({ error: 'Failed to fetch conflicts' });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
}

