import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Optional: include env var diagnostics if requested (for debugging)
  const includeDiagnostics = req.query.diagnostics === 'true';
  
  const response: any = { 
    status: 'ok', 
    timestamp: new Date().toISOString() 
  };

  if (includeDiagnostics) {
    // Show which env vars are set (without values) for debugging
    response.env = {
      MONITORING_DB_HOST: !!process.env.MONITORING_DB_HOST,
      MONITORING_DB_PORT: !!process.env.MONITORING_DB_PORT,
      MONITORING_DB_NAME: !!process.env.MONITORING_DB_NAME,
      MONITORING_DB_USER: !!process.env.MONITORING_DB_USER,
      MONITORING_DB_PASSWORD: !!process.env.MONITORING_DB_PASSWORD,
      // Show lengths for password (to help debug if it's being truncated)
      passwordLength: process.env.MONITORING_DB_PASSWORD?.length || 0,
      // Show first char (masked) to help debug encoding
      passwordFirstChar: process.env.MONITORING_DB_PASSWORD?.[0] || 'none',
    };
  }

  res.status(200).json(response);
}

