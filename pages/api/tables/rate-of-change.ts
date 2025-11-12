import type { NextApiRequest, NextApiResponse } from 'next';
import { RateOfChangeService } from '@/lib/services/rate-of-change.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const { table, schema = 'public', hours } = req.query;
    const service = new RateOfChangeService();

    // If specific table requested, return time series
    if (table && typeof table === 'string') {
      const hoursBack = hours ? parseInt(hours as string, 10) : 24;
      const timeSeries = await service.getRateOfChangeTimeSeries(
        schema as string,
        table,
        hoursBack
      );

      return res.status(200).json({
        table,
        schema,
        timeSeries,
      });
    }

    // Otherwise return all latest rates
    const allRates = await service.getAllLatestRates();
    const ratesArray = Array.from(allRates.values());

    return res.status(200).json({
      rates: ratesArray,
      count: ratesArray.length,
    });

  } catch (error: any) {
    console.error('Error fetching rate of change:', error);
    return res.status(500).json({
      error: error.message || 'Failed to fetch rate of change data',
    });
  }
}
