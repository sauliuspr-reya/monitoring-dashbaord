import type { NextApiRequest, NextApiResponse } from 'next';
import { VerificationService } from '../../../lib/services/verification.service';

/**
 * GET /api/verification/[tableName]
 * Get detailed status for a specific table verification
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tableName } = req.query;

  if (!tableName || typeof tableName !== 'string') {
    return res.status(400).json({ error: 'tableName is required' });
  }

  try {
    const service = new VerificationService();

    // Get job
    const job = await service.getJobByTableName(tableName);
    if (!job) {
      return res.status(404).json({ error: 'No verification found for this table' });
    }

    // Get mismatches and gaps (paginated separately)
    const limit = parseInt(req.query.limit as string) || 100;
    const gapLimit = parseInt(req.query.gapLimit as string) || 10000; // High limit for gaps (collapsed view)
    const mismatchOffset = parseInt(req.query.mismatchOffset as string) || 0;
    const gapOffset = parseInt(req.query.gapOffset as string) || 0;

    const [mismatches, gaps, mismatchCount, gapCount] = await Promise.all([
      service.getMismatches(job.id, limit, mismatchOffset),
      service.getGaps(job.id, gapLimit, gapOffset),
      service.getMismatchCount(job.id),
      service.getGapCount(job.id),
    ]);

    return res.status(200).json({
      job: {
        id: job.id,
        tableName: job.table_name,
        status: job.status,
        batchSize: job.batch_size,
        cooldownMs: job.cooldown_ms,
        primaryKeyColumn: job.primary_key_column,
        startFromPkValue: job.start_from_pk_value,
        lastCheckedPkValue: job.last_checked_pk_value,
        totalRowsChecked: job.total_rows_checked.toString(),
        mismatchesFound: job.mismatches_found,
        gapsFound: job.gaps_found,
        startedAt: job.started_at,
        updatedAt: job.updated_at,
        completedAt: job.completed_at,
        errorMessage: job.error_message,
      },
      mismatches: mismatches.map(m => ({
        id: m.id,
        primaryKeyValue: m.primary_key_value,
        sourceRow: m.source_row,
        targetRow: m.target_row,
        detectedAt: m.detected_at,
      })),
      gaps: gaps.map(g => ({
        id: g.id,
        primaryKeyValue: g.primary_key_value,
        sourceRow: g.source_row,
        detectedAt: g.detected_at,
      })),
      pagination: {
        limit,
        mismatchOffset,
        gapOffset,
        totalMismatches: mismatchCount,
        totalGaps: gapCount,
      },
    });
  } catch (error: any) {
    console.error('[verification/[tableName]] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch verification details' });
  }
}
