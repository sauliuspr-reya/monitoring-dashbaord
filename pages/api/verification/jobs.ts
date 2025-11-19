import type { NextApiRequest, NextApiResponse } from 'next';
import { VerificationService } from '../../../lib/services/verification.service';

/**
 * GET /api/verification/jobs
 * Get all verification jobs (active and historical)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const service = new VerificationService();
    const jobs = await service.getAllJobs();

    const formattedJobs = jobs.map(job => ({
      id: job.id,
      tableName: job.table_name,
      status: job.status,
      batchSize: job.batch_size,
      cooldownMs: job.cooldown_ms,
      primaryKeyColumns: job.primary_key_columns,
      startFromPkValue: job.start_from_pk_value,
      lastCheckedPkValue: job.last_checked_pk_value,
      totalRowsChecked: job.total_rows_checked.toString(),
      mismatchesFound: job.mismatches_found,
      gapsFound: job.gaps_found,
      startedAt: job.started_at,
      updatedAt: job.updated_at,
      completedAt: job.completed_at,
      errorMessage: job.error_message,
    }));

    return res.status(200).json({
      jobs: formattedJobs,
      total: formattedJobs.length,
    });
  } catch (error: any) {
    console.error('[verification/jobs] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch jobs' });
  }
}
