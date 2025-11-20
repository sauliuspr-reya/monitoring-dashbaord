import type { NextApiRequest, NextApiResponse } from 'next';
import { VerificationService } from '../../../../lib/services/verification.service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { tableName } = req.query;

  if (!tableName || typeof tableName !== 'string') {
    return res.status(400).json({ error: 'tableName is required' });
  }

  try {
    const service = new VerificationService();
    const job = await service.getJobByTableName(tableName);

    if (!job) {
      return res.status(404).json({ error: 'No verification job found for this table' });
    }

    const limit = req.body?.limit ? parseInt(req.body.limit, 10) : undefined;
    const chunkSize = req.body?.chunkSize ? parseInt(req.body.chunkSize, 10) : undefined;

    const result = await service.recheckGaps(job.id, {
      limit,
      chunkSize,
    });

    return res.status(200).json({
      message: `Rechecked ${result.rechecked} gap(s)`,
      ...result,
    });
  } catch (error: any) {
    console.error('[verification/recheck-gaps] Error:', error);
    return res.status(500).json({
      error: 'Failed to re-check gaps',
      details: error.message ?? 'Unknown error',
    });
  }
}

