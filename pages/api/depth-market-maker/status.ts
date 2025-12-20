import type { NextApiRequest, NextApiResponse } from 'next';

type Environment = 'staging' | 'cronos';

interface StatusResponse {
  running: boolean;
  pid?: number;
  symbol?: string;
  environment?: Environment;
  logs: string[];
  logCount: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<StatusResponse>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      running: false,
      logs: [],
      logCount: 0,
    });
  }

  // Get optional query params for log pagination
  const lastN = parseInt(req.query.lastN as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;

  const isRunning = global.depthMarketMakerProcess !== null && 
                    global.depthMarketMakerProcess !== undefined && 
                    !global.depthMarketMakerProcess.killed;

  const allLogs = global.depthMarketMakerLogs || [];
  const totalLogs = allLogs.length;
  
  // Get the last N logs, or from offset
  let logs: string[];
  if (offset > 0) {
    logs = allLogs.slice(offset, offset + lastN);
  } else {
    logs = allLogs.slice(-lastN);
  }

  return res.status(200).json({
    running: isRunning,
    pid: isRunning ? global.depthMarketMakerProcess?.pid : undefined,
    symbol: global.depthMarketMakerSymbol || undefined,
    environment: global.depthMarketMakerEnvironment || undefined,
    logs,
    logCount: totalLogs,
  });
}
