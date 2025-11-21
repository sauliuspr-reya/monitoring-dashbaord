import type { NextApiRequest, NextApiResponse } from 'next';
import { getVersionInfo } from '@/lib/version';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const versionInfo = getVersionInfo();
    res.status(200).json(versionInfo);
  } catch (error: any) {
    console.error('Error getting version info:', error);
    res.status(500).json({
      error: 'Failed to get version information',
      details: error.message,
    });
  }
}
