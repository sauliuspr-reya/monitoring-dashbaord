import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool } from '@/lib/db/connection';

/**
 * Health check endpoint for Kubernetes liveness and readiness probes
 * 
 * Checks database connectivity to ensure the app is ready to serve traffic.
 * Returns 200 if healthy, 503 if database is unavailable.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const pool = getDbPool();
    // Use a simple, fast query with timeout
    const result = await Promise.race([
      pool.query('SELECT 1 as health'),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Database query timeout')), 2000)
      )
    ]);
    
    if (result.rows && result.rows.length > 0) {
      return res.status(200).json({ 
        status: 'ok',
        database: 'connected'
      });
    }
    
    return res.status(503).json({ 
      status: 'unhealthy',
      database: 'disconnected'
    });
  } catch (error) {
    // If DB is down, return 503 (Service Unavailable)
    console.error('[healthz] Database health check failed:', error);
    return res.status(503).json({ 
      status: 'unhealthy',
      database: 'error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

