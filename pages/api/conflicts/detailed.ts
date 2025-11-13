import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { GCPLogsService } from '@/lib/services/gcp-logs.service';
import { GoldskyAnalysisService } from '@/lib/services/goldsky-analysis.service';
import { ApplicationTrackingService } from '@/lib/services/application-tracking.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { groupId, tableName } = req.query;

  if (!groupId) {
    return res.status(400).json({ error: 'groupId is required' });
  }

  try {
    const pool = getDbPool();
    
    // Get subscription details
    const groupResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [groupId]);

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const group = groupResult.rows[0];
    const targetPool = createSourceTargetPool(group.target_db_connection);

    try {
      const gcpLogs = new GCPLogsService();
      const goldskyAnalysis = new GoldskyAnalysisService();
      const appTracking = new ApplicationTrackingService();

      // 1. Query GCP Cloud SQL logs for conflicts
      const gcpConflicts = await gcpLogs.queryConflictsFromGCPLogs({
        start: new Date(Date.now() - 24 * 60 * 60 * 1000),
        end: new Date(),
      });

      // Filter by table if specified
      const filteredConflicts = tableName
        ? gcpConflicts.filter((c) => c.tableName === tableName)
        : gcpConflicts;

      // 2. Get Goldsky pipeline info
      const goldskyPipelines = await goldskyAnalysis.parsePipelines();
      const goldskyTables = await goldskyAnalysis.getGoldskyTables();

      // 3. Get application write stats
      const writeStats = await appTracking.getWriteStatsByApplication(targetPool);

      // 4. Enrich conflicts with context
      const enrichedConflicts = filteredConflicts.map((conflict) => {
        const isGoldsky = goldskyTables.has(conflict.tableName);
        const pipeline = goldskyPipelines.find((p) =>
          p.tables.includes(conflict.tableName)
        );
        const writers = writeStats.filter(
          (s) => s.table === conflict.tableName
        );

        return {
          ...conflict,
          isGoldskyTable: isGoldsky,
          goldskyPipeline: pipeline?.name || null,
          goldskyPipelineStatus: pipeline?.status || null,
          writingServices: writers.map((w) => ({
            applicationName: w.applicationName,
            operation: w.operation,
            count: w.count,
            lastWriteTime: w.lastWriteTime,
          })),
        };
      });

      res.status(200).json({
        conflicts: enrichedConflicts,
        summary: {
          total: enrichedConflicts.length,
          byTable: groupByTable(enrichedConflicts),
          byService: groupByService(enrichedConflicts),
          goldskyConflicts: enrichedConflicts.filter((c) => c.isGoldskyTable).length,
        },
      });
    } finally {
      await targetPool.end();
    }
  } catch (error) {
    console.error('Error getting detailed conflicts:', error);
    res.status(500).json({ error: 'Failed to get detailed conflicts' });
  }
}

function groupByTable(conflicts: any[]): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const conflict of conflicts) {
    grouped[conflict.tableName] = (grouped[conflict.tableName] || 0) + 1;
  }
  return grouped;
}

function groupByService(conflicts: any[]): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const conflict of conflicts) {
    for (const service of conflict.writingServices || []) {
      grouped[service.applicationName] = (grouped[service.applicationName] || 0) + 1;
    }
  }
  return grouped;
}

