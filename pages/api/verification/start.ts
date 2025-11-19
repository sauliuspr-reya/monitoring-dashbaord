import type { NextApiRequest, NextApiResponse } from 'next';
import { VerificationService } from '../../../lib/services/verification.service';

/**
 * POST /api/verification/start
 * Start a new verification job or resume an existing one
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tableName, batchSize = 1000, cooldownMs = 100, primaryKeyColumn, startFromPkValue } = req.body;

  if (!tableName) {
    return res.status(400).json({ error: 'tableName is required' });
  }

  if (batchSize < 1 || batchSize > 10000) {
    return res.status(400).json({ error: 'batchSize must be between 1 and 10000' });
  }

  if (cooldownMs < 0 || cooldownMs > 5000) {
    return res.status(400).json({ error: 'cooldownMs must be between 0 and 5000' });
  }

  try {
    const service = new VerificationService();

    // Check if another job is already running
    const runningJob = await service.getRunningJob();
    if (runningJob && runningJob.table_name !== tableName) {
      return res.status(409).json({
        error: 'Another verification is already running',
        runningJob: {
          id: runningJob.id,
          tableName: runningJob.table_name,
          status: runningJob.status,
        },
      });
    }

    // Start or resume verification
    const job = await service.startVerification({
      tableName,
      batchSize,
      cooldownMs,
      primaryKeyColumn,
      startFromPkValue,
    });

    console.log(`[verification/start] Started verification for table: ${tableName}`);

    return res.status(200).json({
      success: true,
      job: {
        id: job.id,
        tableName: job.table_name,
        status: job.status,
        batchSize: job.batch_size,
        cooldownMs: job.cooldown_ms,
        primaryKeyColumn: job.primary_key_column,
        totalRowsChecked: job.total_rows_checked.toString(),
        mismatchesFound: job.mismatches_found,
        gapsFound: job.gaps_found,
        startedAt: job.started_at,
      },
    });
  } catch (error: any) {
    console.error('[verification/start] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to start verification' });
  }
}
