import type { NextApiRequest, NextApiResponse } from 'next';
import { createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', ['DELETE']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const { name } = req.query;
    const { sourceDbConnection } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'Publication name is required',
      });
    }

    // Use provided connection or fall back to environment variable
    const finalSourceConnection = (sourceDbConnection && sourceDbConnection.trim() !== '') 
      ? sourceDbConnection 
      : (process.env.SOURCE_DATABASE_URL || '');

    if (!finalSourceConnection || finalSourceConnection.trim() === '') {
      return res.status(400).json({
        error: 'Source database connection string is required',
        details: 'Please set SOURCE_DATABASE_URL environment variable or provide sourceDbConnection.',
      });
    }

    const sourcePool = createSourceTargetPool(finalSourceConnection);

    try {
      // Check if publication exists
      const pubCheck = await sourcePool.query(`
        SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
      `, [name]);

      if (pubCheck.rows[0].count === '0') {
        await sourcePool.end();
        return res.status(404).json({
          error: 'Publication not found',
          details: `Publication '${name}' does not exist on source database.`,
        });
      }

      // Check if any subscriptions are using this publication
      // Note: We can only check on the target databases we know about
      // The actual check should be done by the user
      
      // Drop the publication
      const escapedPubName = `"${name.replace(/"/g, '""')}"`;
      await sourcePool.query(`
        DROP PUBLICATION ${escapedPubName}
      `);

      res.status(200).json({
        success: true,
        message: `Publication '${name}' has been dropped successfully.`,
      });
    } finally {
      await sourcePool.end();
    }
  } catch (error: any) {
    console.error('[publications/delete] Error:', error);
    res.status(500).json({
      error: 'Failed to drop publication',
      message: error.message,
      details: error.detail || error.message,
    });
  }
}

