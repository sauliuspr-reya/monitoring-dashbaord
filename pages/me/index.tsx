import { useState, useEffect, useCallback } from 'react';
import Navbar from '@/components/Navbar';
import EnvironmentSelector from '@/components/EnvironmentSelector';
import OrderBook from '@/components/OrderBook';
import DepthCredentialsModal, { DepthStartConfig } from '@/components/DepthCredentialsModal';
import { useOrderBook } from '@/lib/hooks/useOrderBook';
import type { Environment, SpotMarketDefinition } from '@/lib/types/orderbook';
import { WS_URLS, API_URLS } from '@/lib/types/orderbook';

interface DepthMarketMakerStatus {
  running: boolean;
  pid?: number;
  symbol?: string;
  environment?: Environment;
  logs: string[];
  logCount: number;
}

export default function MEPage() {
  const [environment, setEnvironment] = useState<Environment>('staging');
  const [markets, setMarkets] = useState<SpotMarketDefinition[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [loadingMarkets, setLoadingMarkets] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  
  // Depth Market Maker state
  const [depthMakerStatus, setDepthMakerStatus] = useState<DepthMarketMakerStatus | null>(null);
  const [depthMakerLoading, setDepthMakerLoading] = useState(false);
  const [showDepthLogs, setShowDepthLogs] = useState(false);
  const [showCredentialsModal, setShowCredentialsModal] = useState(false);

  const wsUrl = WS_URLS[environment];
  const { bids, asks, spread, connectionStatus } = useOrderBook(wsUrl, selectedMarket);

  const fetchMarkets = async (env: Environment) => {
    setLoadingMarkets(true);
    setMarketError(null);
    setSelectedMarket(null);

    try {
      const apiUrl = API_URLS[env];
      const response = await fetch(`${apiUrl}/v2/spotMarketDefinitions`);

      if (!response.ok) {
        throw new Error(`Failed to fetch markets: ${response.status}`);
      }

      const data = await response.json();
      const marketsList: SpotMarketDefinition[] = Array.isArray(data) ? data : data.markets || [];

      setMarkets(marketsList);

      if (marketsList.length > 0) {
        setSelectedMarket(marketsList[0].symbol);
      }
    } catch (error) {
      console.error('[MEPage] Failed to fetch markets:', error);
      setMarketError(error instanceof Error ? error.message : 'Failed to fetch markets');
      setMarkets([]);
    } finally {
      setLoadingMarkets(false);
    }
  };

  useEffect(() => {
    fetchMarkets(environment);
  }, [environment]);

  const handleEnvironmentChange = (env: Environment) => {
    setEnvironment(env);
  };

  const handleMarketChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedMarket(event.target.value);
  };

  // Fetch depth market maker status
  const fetchDepthMakerStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/depth-market-maker/status');
      if (response.ok) {
        const data = await response.json();
        setDepthMakerStatus(data);
      }
    } catch (error) {
      console.error('[MEPage] Failed to fetch depth maker status:', error);
    }
  }, []);

  // Poll for status when running
  useEffect(() => {
    fetchDepthMakerStatus();
    const interval = setInterval(fetchDepthMakerStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchDepthMakerStatus]);

  const handleOpenCredentialsModal = () => {
    if (!selectedMarket) return;
    setShowCredentialsModal(true);
  };

  const handleStartDepthMaker = async (config: DepthStartConfig) => {
    setDepthMakerLoading(true);
    try {
      const requestBody: Record<string, string> = {
        symbol: config.symbol,
        environment: config.environment,
      };

      // Add custom credentials if provided
      if (config.credentials) {
        requestBody.spotAccountId = config.credentials.spotAccountId;
        requestBody.spotPrivateKey = config.credentials.spotPrivateKey;
        requestBody.spotWalletAddress = config.credentials.spotWalletAddress;
      }

      const response = await fetch('/api/depth-market-maker/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      
      const data = await response.json();
      if (!response.ok) {
        alert(data.message || 'Failed to start depth market maker');
      } else {
        setShowDepthLogs(true);
        setShowCredentialsModal(false);
      }
      await fetchDepthMakerStatus();
    } catch (error) {
      console.error('[MEPage] Failed to start depth maker:', error);
      alert('Failed to start depth market maker');
    } finally {
      setDepthMakerLoading(false);
    }
  };

  const handleStopDepthMaker = async () => {
    setDepthMakerLoading(true);
    try {
      const response = await fetch('/api/depth-market-maker/stop', {
        method: 'POST',
      });
      
      const data = await response.json();
      if (!response.ok) {
        alert(data.message || 'Failed to stop depth market maker');
      }
      await fetchDepthMakerStatus();
    } catch (error) {
      console.error('[MEPage] Failed to stop depth maker:', error);
      alert('Failed to stop depth market maker');
    } finally {
      setDepthMakerLoading(false);
    }
  };

  const isDepthMakerRunning = depthMakerStatus?.running ?? false;
  const isDepthMakerForCurrentMarket = depthMakerStatus?.symbol === selectedMarket;

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              ME - Matching Engine
            </h1>
            <p className="mt-2 text-gray-600">
              Real-time order book data from the matching engine for spot markets.
            </p>
          </div>

          <div className="mb-6 flex flex-wrap items-center gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Environment
              </label>
              <EnvironmentSelector
                selectedEnvironment={environment}
                onEnvironmentChange={handleEnvironmentChange}
                disabled={loadingMarkets}
              />
            </div>

            <div>
              <label
                htmlFor="market-select"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Spot Market
              </label>
              <select
                id="market-select"
                value={selectedMarket || ''}
                onChange={handleMarketChange}
                disabled={loadingMarkets || markets.length === 0}
                className="block w-48 px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Select spot market"
              >
                {loadingMarkets && (
                  <option key="loading" value="">Loading markets...</option>
                )}
                {!loadingMarkets && markets.length === 0 && (
                  <option key="no-markets" value="">No markets available</option>
                )}
                {markets.map((market) => (
                  <option key={`market-${market.spotMarketId}`} value={market.symbol}>
                    {market.symbol}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Depth Provider
              </label>
              {isDepthMakerRunning ? (
                <button
                  type="button"
                  onClick={handleStopDepthMaker}
                  disabled={depthMakerLoading}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Stop depth market maker"
                  tabIndex={0}
                >
                  {depthMakerLoading ? 'Stopping...' : `Stop Depth (${depthMakerStatus?.symbol})`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleOpenCredentialsModal}
                  disabled={depthMakerLoading || !selectedMarket}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Start depth market maker"
                  tabIndex={0}
                >
                  Run Depth
                </button>
              )}
            </div>

            {marketError && (
              <div className="flex items-center gap-2 text-red-600 text-sm">
                <span>⚠️ {marketError}</span>
                <button
                  type="button"
                  onClick={() => fetchMarkets(environment)}
                  className="underline hover:no-underline"
                  aria-label="Retry fetching markets"
                  tabIndex={0}
                >
                  Retry
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <OrderBook
              bids={bids}
              asks={asks}
              spread={spread}
              connectionStatus={connectionStatus}
              symbol={selectedMarket}
            />

            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Connection Info
              </h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Environment</span>
                  <span className="font-medium text-gray-900 capitalize">{environment}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">WebSocket URL</span>
                  <span className="font-mono text-xs text-gray-700 break-all">{wsUrl}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Channel</span>
                  <span className="font-mono text-xs text-gray-700">
                    {selectedMarket ? `/v2/market/${selectedMarket}/depth` : '-'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Bid Levels</span>
                  <span className="font-medium text-gray-900">{bids.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Ask Levels</span>
                  <span className="font-medium text-gray-900">{asks.length}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Depth Market Maker Logs */}
          {(isDepthMakerRunning || (depthMakerStatus?.logs && depthMakerStatus.logs.length > 0)) && (
            <div className="mt-6 bg-white rounded-lg shadow">
              <div className="flex justify-between items-center px-4 py-3 border-b border-gray-200">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  Depth Market Maker Logs
                  {isDepthMakerRunning && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                      Running
                    </span>
                  )}
                </h3>
                <button
                  type="button"
                  onClick={() => setShowDepthLogs(!showDepthLogs)}
                  className="text-sm text-blue-600 hover:text-blue-800"
                  aria-label={showDepthLogs ? 'Hide logs' : 'Show logs'}
                  tabIndex={0}
                >
                  {showDepthLogs ? 'Hide' : 'Show'} ({depthMakerStatus?.logCount || 0} lines)
                </button>
              </div>
              {showDepthLogs && (
                <div className="p-4 bg-gray-900 rounded-b-lg max-h-64 overflow-y-auto">
                  <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap">
                    {depthMakerStatus?.logs?.length ? (
                      depthMakerStatus.logs.map((log, i) => (
                        <div
                          key={i}
                          className={
                            log.includes('[stderr]') || log.includes('[error]')
                              ? 'text-red-400'
                              : log.includes('[system]')
                              ? 'text-yellow-400'
                              : 'text-gray-300'
                          }
                        >
                          {log}
                        </div>
                      ))
                    ) : (
                      <span className="text-gray-500">No logs yet...</span>
                    )}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <DepthCredentialsModal
        isOpen={showCredentialsModal}
        onClose={() => setShowCredentialsModal(false)}
        onStart={handleStartDepthMaker}
        initialSymbol={selectedMarket || ''}
        initialEnvironment={environment}
        markets={markets}
        isLoading={depthMakerLoading}
      />
    </>
  );
}
