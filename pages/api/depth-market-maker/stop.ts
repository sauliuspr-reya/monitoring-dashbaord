import type { NextApiRequest, NextApiResponse } from 'next';

interface StopResponse {
  success: boolean;
  message: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<StopResponse>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  if (!global.depthMarketMakerProcess || global.depthMarketMakerProcess.killed) {
    return res.status(400).json({
      success: false,
      message: 'Depth market maker is not running',
    });
  }

  try {
    const symbol = global.depthMarketMakerSymbol;
    
    // Send SIGINT (like Ctrl+C) to allow graceful shutdown with order cancellation
    global.depthMarketMakerProcess.kill('SIGINT');
    
    // Give it time to cancel orders and clean up, then force kill if needed
    setTimeout(() => {
      if (global.depthMarketMakerProcess && !global.depthMarketMakerProcess.killed) {
        global.depthMarketMakerLogs.push(`[system] Force killing process after timeout...`);
        global.depthMarketMakerProcess.kill('SIGKILL');
      }
    }, 10000); // 10 seconds to allow mass cancel

    global.depthMarketMakerLogs.push(`[system] Stop requested, sending SIGINT for graceful shutdown...`);

    return res.status(200).json({
      success: true,
      message: `Depth market maker for ${symbol} is stopping (orders will be cancelled)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({
      success: false,
      message: `Failed to stop depth market maker: ${errorMessage}`,
    });
  }
}
