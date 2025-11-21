import type { NextApiRequest, NextApiResponse } from 'next';
import { VerificationService } from '@/lib/services/verification.service';
import { createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method not allowed' });
    }

    const { jobId } = req.body;

    if (!jobId) {
        return res.status(400).json({ message: 'Missing jobId' });
    }

    const service = new VerificationService();
    let targetPool = null;

    try {
        const targetUrl = process.env.TARGET_DATABASE_URL;
        if (!targetUrl) {
            throw new Error('TARGET_DATABASE_URL not configured');
        }

        targetPool = createSourceTargetPool(targetUrl);

        const { restored, errors, errorMessages } = await service.restoreGaps(Number(jobId), targetPool);

        res.status(200).json({ restored, errors, errorMessages });
    } catch (error: any) {
        console.error('Error restoring gaps:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally {
        if (targetPool) {
            await targetPool.end().catch(console.error);
        }
    }
}
