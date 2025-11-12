import type { NextApiRequest, NextApiResponse } from 'next';
import { GCPLogsService } from '@/lib/services/gcp-logs.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { tableName, hours = '24' } = req.query;

  try {
    const gcpLogs = new GCPLogsService();
    
    const hoursNum = parseInt(hours as string, 10);
    const timeRange = {
      start: new Date(Date.now() - hoursNum * 60 * 60 * 1000),
      end: new Date(),
    };

    let conflicts = await gcpLogs.queryConflictsFromGCPLogs(timeRange);

    // Filter by table if specified
    if (tableName) {
      conflicts = conflicts.filter((c) => c.tableName === tableName);
    }

    // Group by table
    const byTable: Record<string, number> = {};
    for (const conflict of conflicts) {
      byTable[conflict.tableName] = (byTable[conflict.tableName] || 0) + 1;
    }

    res.status(200).json({
      conflicts,
      summary: {
        total: conflicts.length,
        byTable,
        timeRange: {
          start: timeRange.start.toISOString(),
          end: timeRange.end.toISOString(),
        },
      },
    });
  } catch (error) {
    console.error('Error querying GCP logs:', error);
    res.status(500).json({ 
      error: 'Failed to query GCP logs',
      message: error instanceof Error ? error.message : 'Unknown error',
      hint: 'Make sure gcloud CLI is installed and authenticated, and GCP_PROJECT_ID/GCP_CLOUD_SQL_INSTANCE_ID are set'
    });
  }
}

