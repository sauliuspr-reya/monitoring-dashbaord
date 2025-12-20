import type { NextApiRequest, NextApiResponse } from 'next';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

// Store the running process globally (in-memory, will be lost on restart)
type Environment = 'staging' | 'cronos';

// Environment-specific configuration
const ENV_CONFIG: Record<Environment, { wsUrl: string; apiUrl: string; chainId: string }> = {
  staging: {
    wsUrl: 'wss://websocket-staging.reya.xyz/',
    apiUrl: 'https://api-staging.reya.xyz/v2',
    chainId: '1729', // staging uses mainnet chain ID
  },
  cronos: {
    wsUrl: 'wss://websocket-testnet.reya.xyz/',
    apiUrl: 'https://api-cronos.reya.xyz/v2',
    chainId: '89346162', // testnet
  },
};

declare global {
  var depthMarketMakerProcess: ChildProcess | null;
  var depthMarketMakerLogs: string[];
  var depthMarketMakerSymbol: string | null;
  var depthMarketMakerEnvironment: Environment | null;
}

global.depthMarketMakerProcess = global.depthMarketMakerProcess || null;
global.depthMarketMakerLogs = global.depthMarketMakerLogs || [];
global.depthMarketMakerSymbol = global.depthMarketMakerSymbol || null;
global.depthMarketMakerEnvironment = global.depthMarketMakerEnvironment || null;

const MAX_LOG_LINES = 500;

interface StartRequest {
  symbol: string;
  environment: Environment;
  oracleSymbol?: string;
  // Optional custom credentials (if not provided, uses .env defaults)
  spotAccountId?: string;
  spotPrivateKey?: string;
  spotWalletAddress?: string;
}

interface StartResponse {
  success: boolean;
  message: string;
  pid?: number;
  symbol?: string;
  environment?: Environment;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<StartResponse>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  // Check if already running
  if (global.depthMarketMakerProcess && !global.depthMarketMakerProcess.killed) {
    return res.status(400).json({
      success: false,
      message: `Depth market maker is already running for ${global.depthMarketMakerSymbol} on ${global.depthMarketMakerEnvironment}. Stop it first before starting a new one.`,
      pid: global.depthMarketMakerProcess.pid,
      symbol: global.depthMarketMakerSymbol || undefined,
      environment: global.depthMarketMakerEnvironment || undefined,
    });
  }

  const { symbol, environment, oracleSymbol, spotAccountId, spotPrivateKey, spotWalletAddress } = req.body as StartRequest;

  if (!symbol) {
    return res.status(400).json({ success: false, message: 'Symbol is required' });
  }

  if (!environment || !ENV_CONFIG[environment]) {
    return res.status(400).json({ success: false, message: 'Valid environment is required (staging or cronos)' });
  }

  const envConfig = ENV_CONFIG[environment];

  // Derive oracle symbol from spot symbol if not provided
  // e.g., WETHRUSD -> ETHRUSD (remove the 'W' prefix for wrapped tokens)
  const derivedOracleSymbol = oracleSymbol || symbol.replace(/^W/, '');

  // Path to the Python SDK and script
  const pythonSdkPath = process.env.PYTHON_SDK_PATH || '/app/reya-python-sdk';
  const pythonPath = path.join(pythonSdkPath, '.venv', 'bin', 'python');
  const scriptPath = path.join(pythonSdkPath, 'examples', 'websocket', 'spot', 'depth_market_maker.py');

  // Clear previous logs and set current state
  global.depthMarketMakerLogs = [];
  global.depthMarketMakerSymbol = symbol;
  global.depthMarketMakerEnvironment = environment;

  try {
    // Build environment variables, using custom credentials if provided
    const envVars: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      REYA_WS_URL: envConfig.wsUrl,
      REYA_API_BASE_URL: envConfig.apiUrl,
      CHAIN_ID: envConfig.chainId,
    };

    // Override with custom credentials if provided
    if (spotAccountId) {
      envVars.SPOT_ACCOUNT_ID_1 = spotAccountId;
    }
    if (spotPrivateKey) {
      envVars.SPOT_PRIVATE_KEY_1 = spotPrivateKey;
    }
    if (spotWalletAddress) {
      envVars.SPOT_WALLET_ADDRESS_1 = spotWalletAddress;
    }

    // Spawn the Python process with environment-specific config
    const childProcess = spawn(pythonPath, [
      '-u', // Unbuffered output
      scriptPath,
      '--symbol', symbol,
      '--oracle-symbol', derivedOracleSymbol,
    ], {
      cwd: pythonSdkPath,
      env: envVars,
    });

    global.depthMarketMakerLogs.push(`[system] Starting depth market maker for ${symbol} on ${environment}`);
    global.depthMarketMakerLogs.push(`[system] WS URL: ${envConfig.wsUrl}`);
    global.depthMarketMakerLogs.push(`[system] API URL: ${envConfig.apiUrl}`);

    global.depthMarketMakerProcess = childProcess;

    // Capture stdout
    childProcess.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => {
        global.depthMarketMakerLogs.push(line);
        if (global.depthMarketMakerLogs.length > MAX_LOG_LINES) {
          global.depthMarketMakerLogs.shift();
        }
      });
    });

    // Capture stderr (Python logging goes to stderr by default, so we treat it as normal output)
    childProcess.stderr.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => {
        global.depthMarketMakerLogs.push(line);
        if (global.depthMarketMakerLogs.length > MAX_LOG_LINES) {
          global.depthMarketMakerLogs.shift();
        }
      });
    });

    // Handle process exit
    childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      global.depthMarketMakerLogs.push(`[system] Process exited with code ${code}, signal ${signal}`);
      global.depthMarketMakerProcess = null;
    });

    // Handle errors
    childProcess.on('error', (error: Error) => {
      global.depthMarketMakerLogs.push(`[error] ${error.message}`);
      global.depthMarketMakerProcess = null;
    });

    return res.status(200).json({
      success: true,
      message: `Depth market maker started for ${symbol} on ${environment}`,
      pid: childProcess.pid,
      symbol,
      environment,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({
      success: false,
      message: `Failed to start depth market maker: ${errorMessage}`,
    });
  }
}
