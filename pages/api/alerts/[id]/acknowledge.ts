import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool } from '@/lib/db/connection';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;
  const { acknowledgedBy } = req.body;

  if (!acknowledgedBy) {
    return res.status(400).json({ error: 'acknowledgedBy is required' });
  }

  try {
    const pool = getDbPool();
    await pool.query(`
      UPDATE alerts
      SET acknowledged = true,
          acknowledged_at = NOW(),
          acknowledged_by = $1
      WHERE id = $2
    `, [acknowledgedBy, id]);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error acknowledging alert:', error);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
}

