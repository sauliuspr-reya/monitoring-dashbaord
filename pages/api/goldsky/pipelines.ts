import type { NextApiRequest, NextApiResponse } from 'next';
import { GoldskyAnalysisService } from '@/lib/services/goldsky-analysis.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const goldskyAnalysis = new GoldskyAnalysisService();
    const pipelines = await goldskyAnalysis.parsePipelines();
    const allTables = await goldskyAnalysis.getGoldskyTables();

    res.status(200).json({
      pipelines: pipelines.map((p) => ({
        name: p.name,
        status: p.status,
        tables: p.tables,
        primaryKeys: Object.fromEntries(p.primaryKeys),
      })),
      allTables: Array.from(allTables),
      summary: {
        totalPipelines: pipelines.length,
        activePipelines: pipelines.filter((p) => p.status === 'active').length,
        pausedPipelines: pipelines.filter((p) => p.status === 'paused').length,
        totalTables: allTables.size,
      },
    });
  } catch (error) {
    console.error('Error getting Goldsky pipelines:', error);
    res.status(500).json({ error: 'Failed to get Goldsky pipelines' });
  }
}

