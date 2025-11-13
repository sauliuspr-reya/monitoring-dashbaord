import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { LogAnalysisService } from '@/lib/services/log-analysis.service';
import { GoldskyAnalysisService } from '@/lib/services/goldsky-analysis.service';
import { ApplicationTrackingService } from '@/lib/services/application-tracking.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { groupId } = req.query;

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
      const logAnalysis = new LogAnalysisService();
      const goldskyAnalysis = new GoldskyAnalysisService();
      const appTracking = new ApplicationTrackingService();

      // 1. Get conflicts from logs
      const logConflicts = await logAnalysis.detectConflictsFromLogs(targetPool);

      // 2. Get Goldsky pipeline info
      const goldskyPipelines = await goldskyAnalysis.parsePipelines();
      const goldskyTables = await goldskyAnalysis.getGoldskyTables();

      // 3. Get application write stats
      const writeStats = await appTracking.getWriteStatsByApplication(targetPool);

      // 4. Correlate conflicts with services and Goldsky
      const enrichedConflicts = logConflicts.map((conflict) => {
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
          writingServices: writers.map((w) => ({
            applicationName: w.applicationName,
            operation: w.operation,
            count: w.count,
          })),
        };
      });

      res.status(200).json({
        conflicts: enrichedConflicts,
        goldskyPipelines: goldskyPipelines.map((p) => ({
          name: p.name,
          status: p.status,
          tables: p.tables,
        })),
        writeStats: writeStats.slice(0, 100), // Limit to top 100
      });
    } finally {
      await targetPool.end();
    }
  } catch (error) {
    console.error('Error analyzing conflicts:', error);
    res.status(500).json({ error: 'Failed to analyze conflicts' });
  }
}

