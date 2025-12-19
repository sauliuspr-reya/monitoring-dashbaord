import { useState, useEffect } from 'react';
import Navbar from '@/components/Navbar';
import EnvironmentSelector from '@/components/EnvironmentSelector';
import OrderBook from '@/components/OrderBook';
import { useOrderBook } from '@/lib/hooks/useOrderBook';
import type { Environment, SpotMarketDefinition } from '@/lib/types/orderbook';
import { WS_URLS, API_URLS } from '@/lib/types/orderbook';

export default function MEPage() {
  const [environment, setEnvironment] = useState<Environment>('staging');
  const [markets, setMarkets] = useState<SpotMarketDefinition[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [loadingMarkets, setLoadingMarkets] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

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
                className="block w-48 px-3 py-2 bg-white border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
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
        </div>
      </div>
    </>
  );
}
