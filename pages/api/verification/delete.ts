import type { NextApiRequest, NextApiResponse } from 'next';
import { VerificationService } from '../../../lib/services/verification.service';

/**
 * POST /api/verification/delete
 * Delete a verification job and all associated data
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

    // Delete the job (CASCADE will delete mismatches and gaps)
    await service.deleteJobByTableName(tableName);

    console.log(`[verification/delete] Deleted verification for table: ${tableName}`);

    return res.status(200).json({
      success: true,
      message: `Verification for ${tableName} has been deleted`,
    });
  } catch (error: any) {
    console.error('[verification/delete] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to delete verification' });
  }
}
