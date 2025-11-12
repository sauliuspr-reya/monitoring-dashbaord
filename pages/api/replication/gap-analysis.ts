import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool } from '../../../lib/db/connection';

interface TableGap {
  schema: string;
  table: string;
  sourceRows: number;
  targetRows: number;
  gap: number;
  gapPercentage: number;
  estimatedCatchupTime?: string;
}

interface GapAnalysis {
  totalTables: number;
  tablesWithGaps: number;
  totalGapRows: number;
  largestGaps: TableGap[];
  replicationMode: 'copy_data_true' | 'copy_data_false' | 'unknown';
  estimatedTotalCatchupTime?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const pool = getDbPool();

    // Get subscriptions to check copy_data setting
    const subscriptions = await pool.query(`
      SELECT 
        id,
        name,
        source_db_connection,
        target_db_connection
      FROM subscriptions
      ORDER BY name
    `);

    if (subscriptions.rows.length === 0) {
      return res.status(200).json({
        totalTables: 0,
        tablesWithGaps: 0,
        totalGapRows: 0,
        largestGaps: [],
        replicationMode: 'unknown',
        message: 'No subscriptions configured'
      });
    }

    // Get table metrics to calculate gaps
    const metrics = await pool.query(`
      SELECT 
        table_name,
        source_row_count,
        target_row_count,
        ABS(source_row_count - target_row_count) as gap
      FROM table_replication_metrics
      WHERE timestamp > NOW() - INTERVAL '10 minutes'
      ORDER BY gap DESC
    `);

    const tablesWithGaps = metrics.rows.filter(row => row.gap > 0);
    const totalGapRows = tablesWithGaps.reduce((sum, row) => sum + parseInt(row.gap), 0);

    // Estimate catchup time based on replication rate
    // Assume average replication rate of 1000 rows/second
    const avgReplicationRate = 1000;
    const estimatedSeconds = totalGapRows / avgReplicationRate;
    const estimatedHours = Math.ceil(estimatedSeconds / 3600);

    const largestGaps: TableGap[] = tablesWithGaps.slice(0, 20).map(row => ({
      schema: 'public',
      table: row.table_name,
      sourceRows: parseInt(row.source_row_count),
      targetRows: parseInt(row.target_row_count),
      gap: parseInt(row.gap),
      gapPercentage: (parseInt(row.gap) / parseInt(row.source_row_count)) * 100,
      estimatedCatchupTime: formatDuration(parseInt(row.gap) / avgReplicationRate)
    }));

    const response: GapAnalysis = {
      totalTables: metrics.rows.length,
      tablesWithGaps: tablesWithGaps.length,
      totalGapRows,
      largestGaps,
      replicationMode: 'unknown', // Would need to query pg_subscription to determine
      estimatedTotalCatchupTime: formatDuration(estimatedSeconds)
    };

    res.status(200).json(response);
  } catch (error: any) {
    console.error('Error analyzing replication gaps:', error);
    res.status(500).json({ 
      error: 'Failed to analyze replication gaps',
      details: error.message 
    });
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.ceil(seconds)}s`;
  } else if (seconds < 3600) {
    return `${Math.ceil(seconds / 60)}m`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.ceil((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  } else {
    const days = Math.floor(seconds / 86400);
    const hours = Math.ceil((seconds % 86400) / 3600);
    return `${days}d ${hours}h`;
  }
}
