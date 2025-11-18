import type { NextApiRequest, NextApiResponse } from 'next';
import { VerificationService } from '../../../lib/services/verification.service';

/**
 * POST /api/verification/stop
 * Stop a running verification job
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tableName } = req.body;

  if (!tableName) {
    return res.status(400).json({ error: 'tableName is required' });
  }

  try {
    const service = new VerificationService();

    // Check if job exists and is running
    const job = await service.getJobByTableName(tableName);
    if (!job) {
      return res.status(404).json({ error: 'No verification found for this table' });
    }

    if (job.status !== 'running') {
      return res.status(400).json({ 
        error: `Verification is not running (current status: ${job.status})` 
      });
    }

    // Stop the job
    await service.stopVerification(tableName);

    console.log(`[verification/stop] Stopped verification for table: ${tableName}`);

    return res.status(200).json({
      success: true,
      message: 'Verification will stop after current batch completes',
      jobId: job.id,
    });
  } catch (error: any) {
    console.error('[verification/stop] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to stop verification' });
  }
}
