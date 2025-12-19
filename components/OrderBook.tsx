import { useState, useEffect, useRef, useMemo } from 'react';
import type { DisplayLevel, Spread, ConnectionStatus } from '@/lib/types/orderbook';

interface OrderBookProps {
  bids: DisplayLevel[];
  asks: DisplayLevel[];
  spread: Spread | null;
  connectionStatus: ConnectionStatus;
  symbol: string | null;
}

const ConnectionStatusIndicator = ({ status }: { status: ConnectionStatus }) => {
  const statusConfig: Record<ConnectionStatus, { color: string; label: string }> = {
    connecting: { color: 'bg-yellow-500', label: 'Connecting...' },
    connected: { color: 'bg-green-500', label: 'Connected' },
    disconnected: { color: 'bg-gray-500', label: 'Disconnected' },
    error: { color: 'bg-red-500', label: 'Error' },
  };

  const config = statusConfig[status];

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`w-2 h-2 rounded-full ${config.color}`} />
      <span className="text-gray-600">{config.label}</span>
    </div>
  );
};

interface PriceLevelRowProps {
  level: DisplayLevel;
  side: 'bid' | 'ask';
  depthPercent: number;
  isFlashing: boolean;
}

const PriceLevelRow = ({ level, side, depthPercent, isFlashing }: PriceLevelRowProps) => {
  const isBid = side === 'bid';
  const textColor = isBid ? 'text-green-600' : 'text-red-600';
  const barColor = isBid ? 'bg-green-500/20' : 'bg-red-500/20';
  const flashColor = isBid ? 'bg-green-500/40' : 'bg-red-500/40';

  return (
    <tr className="hover:bg-gray-50/50">
      <td className={`relative py-1 px-3 text-right font-mono text-sm ${textColor}`}>
        <div
          className={`absolute inset-0 transition-all duration-300 ${isFlashing ? flashColor : barColor}`}
          style={{ width: `${Math.min(depthPercent * 3, 300)}%` }}
          aria-hidden="true"
        />
        <span className="relative">{parseFloat(level.px).toFixed(4)}</span>
      </td>
      <td className="relative py-1 px-3 text-right font-mono text-sm text-gray-700">
        <span className="relative">{parseFloat(level.qty).toFixed(4)}</span>
      </td>
      <td className="relative py-1 px-3 text-right font-mono text-sm text-gray-500">
        <span className="relative">{parseFloat(level.total).toFixed(4)}</span>
      </td>
    </tr>
  );
};

export default function OrderBook({
  bids,
  asks,
  spread,
  connectionStatus,
  symbol,
}: OrderBookProps) {
  const hasData = bids.length > 0 || asks.length > 0;
  const prevLevelsRef = useRef<Map<string, string>>(new Map());
  const [flashingLevels, setFlashingLevels] = useState<Set<string>>(new Set());

  const maxSize = useMemo(() => {
    const allSizes = [...bids, ...asks].map((level) => parseFloat(level.qty));
    return Math.max(...allSizes, 0.0001);
  }, [bids, asks]);

  useEffect(() => {
    const newFlashing = new Set<string>();
    const currentLevels = new Map<string, string>();

    [...bids, ...asks].forEach((level) => {
      const key = level.px;
      currentLevels.set(key, level.qty);

      const prevQty = prevLevelsRef.current.get(key);
      if (prevQty === undefined || prevQty !== level.qty) {
        newFlashing.add(key);
      }
    });

    if (newFlashing.size > 0) {
      setFlashingLevels(newFlashing);

      const timeout = setTimeout(() => {
        setFlashingLevels(new Set());
      }, 300);

      prevLevelsRef.current = currentLevels;
      return () => clearTimeout(timeout);
    }

    prevLevelsRef.current = currentLevels;
  }, [bids, asks]);

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="flex justify-between items-center px-4 py-3 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900">
          Order Book {symbol ? `- ${symbol}` : ''}
        </h3>
        <ConnectionStatusIndicator status={connectionStatus} />
      </div>

      <div className="overflow-hidden">
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-b border-gray-200 relative z-10">
              <th className="py-2 px-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                Price
              </th>
              <th className="py-2 px-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                Size
              </th>
              <th className="py-2 px-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {asks.map((level, index) => {
              const depthPercent = (parseFloat(level.qty) / maxSize) * 100;
              return (
                <PriceLevelRow
                  key={`ask-${level.px}-${index}`}
                  level={level}
                  side="ask"
                  depthPercent={depthPercent}
                  isFlashing={flashingLevels.has(level.px)}
                />
              );
            })}

            {spread && (
              <tr className="bg-gray-100 border-y border-gray-300 relative z-10">
                <td
                  colSpan={3}
                  className="py-2 px-3 text-center text-sm font-medium text-gray-700 bg-gray-100"
                >
                  Spread: {spread.value} ({spread.percent}%)
                </td>
              </tr>
            )}

            {bids.map((level, index) => {
              const depthPercent = (parseFloat(level.qty) / maxSize) * 100;
              return (
                <PriceLevelRow
                  key={`bid-${level.px}-${index}`}
                  level={level}
                  side="bid"
                  depthPercent={depthPercent}
                  isFlashing={flashingLevels.has(level.px)}
                />
              );
            })}
          </tbody>
        </table>

        {!hasData && connectionStatus === 'connected' && (
          <div className="py-8 text-center text-gray-500">
            No order book data available
          </div>
        )}

        {!hasData && connectionStatus === 'connecting' && (
          <div className="py-8 text-center text-gray-500">
            Loading order book...
          </div>
        )}

        {!hasData && connectionStatus === 'disconnected' && (
          <div className="py-8 text-center text-gray-500">
            Select a market to view order book
          </div>
        )}

        {!hasData && connectionStatus === 'error' && (
          <div className="py-8 text-center text-red-500">
            Failed to connect. Retrying...
          </div>
        )}
      </div>
    </div>
  );
}
