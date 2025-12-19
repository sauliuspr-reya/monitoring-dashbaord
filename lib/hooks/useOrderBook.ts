import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  PriceLevel,
  DepthData,
  DisplayLevel,
  Spread,
  ConnectionStatus,
} from '../types/orderbook';

interface UseOrderBookResult {
  bids: DisplayLevel[];
  asks: DisplayLevel[];
  spread: Spread | null;
  connectionStatus: ConnectionStatus;
  lastUpdateTime: number | null;
}

const DISPLAY_LEVELS = 15;
const UI_UPDATE_INTERVAL_MS = 1000;

const calculateCumulativeTotal = (levels: PriceLevel[]): DisplayLevel[] => {
  let cumulative = 0;
  return levels.map((level) => {
    cumulative += parseFloat(level.qty);
    return {
      px: level.px,
      qty: level.qty,
      total: cumulative.toFixed(4),
    };
  });
};

const calculateSpread = (
  bestBid: PriceLevel | undefined,
  bestAsk: PriceLevel | undefined
): Spread | null => {
  if (!bestBid || !bestAsk) {
    return null;
  }

  const bidPrice = parseFloat(bestBid.px);
  const askPrice = parseFloat(bestAsk.px);
  const spreadValue = askPrice - bidPrice;
  const midPrice = (askPrice + bidPrice) / 2;
  const spreadPercent = midPrice > 0 ? (spreadValue / midPrice) * 100 : 0;

  return {
    value: spreadValue.toFixed(4),
    percent: spreadPercent.toFixed(4),
  };
};

export const useOrderBook = (
  wsUrl: string | null,
  symbol: string | null
): UseOrderBookResult => {
  const bidsMapRef = useRef<Map<string, string>>(new Map());
  const asksMapRef = useRef<Map<string, string>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isCleaningUpRef = useRef(false);
  const currentParamsRef = useRef<{ wsUrl: string | null; symbol: string | null }>({ wsUrl: null, symbol: null });

  const [bids, setBids] = useState<DisplayLevel[]>([]);
  const [asks, setAsks] = useState<DisplayLevel[]>([]);
  const [spread, setSpread] = useState<Spread | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [lastUpdateTime, setLastUpdateTime] = useState<number | null>(null);

  const updateDisplayState = useCallback(() => {
    const sortedBids: PriceLevel[] = Array.from(bidsMapRef.current.entries())
      .map(([px, qty]) => ({ px, qty }))
      .sort((a, b) => parseFloat(b.px) - parseFloat(a.px));

    const sortedAsks: PriceLevel[] = Array.from(asksMapRef.current.entries())
      .map(([px, qty]) => ({ px, qty }))
      .sort((a, b) => parseFloat(a.px) - parseFloat(b.px));

    const displayBids = calculateCumulativeTotal(sortedBids.slice(0, DISPLAY_LEVELS));
    const displayAsks = calculateCumulativeTotal(sortedAsks.slice(0, DISPLAY_LEVELS));

    const newSpread = calculateSpread(sortedBids[0], sortedAsks[0]);

    setBids(displayBids);
    setAsks(displayAsks.reverse());
    setSpread(newSpread);
    setLastUpdateTime(Date.now());
  }, []);

  useEffect(() => {
    currentParamsRef.current = { wsUrl, symbol };
    isCleaningUpRef.current = false;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    bidsMapRef.current.clear();
    asksMapRef.current.clear();
    setBids([]);
    setAsks([]);
    setSpread(null);

    if (!wsUrl || !symbol) {
      setConnectionStatus('disconnected');
      return;
    }

    setConnectionStatus('connecting');

    const connect = () => {
      if (isCleaningUpRef.current) {
        return;
      }

      if (currentParamsRef.current.wsUrl !== wsUrl || currentParamsRef.current.symbol !== symbol) {
        return;
      }

      console.log('[useOrderBook] Connecting to', wsUrl, 'for symbol', symbol);

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isCleaningUpRef.current || ws !== wsRef.current) {
          ws.close();
          return;
        }

        console.log('[useOrderBook] Connected, subscribing to', `/v2/market/${symbol}/depth`);
        setConnectionStatus('connected');

        const subscribeMessage = {
          type: 'subscribe',
          channel: `/v2/market/${symbol}/depth`,
        };
        ws.send(JSON.stringify(subscribeMessage));
      };

      ws.onmessage = (event: MessageEvent) => {
        if (isCleaningUpRef.current || ws !== wsRef.current) {
          return;
        }

        try {
          const rawMessage = JSON.parse(event.data);

          console.log('[useOrderBook] Received message:', rawMessage.type);

          let data: DepthData | null = null;

          if (rawMessage.type === 'subscribed' && rawMessage.contents) {
            console.log('[useOrderBook] Processing subscribed message with snapshot');
            data = rawMessage.contents as DepthData;
          } else if (rawMessage.type === 'channel_data' && rawMessage.data) {
            data = rawMessage.data as DepthData;
          }

          if (!data) {
            return;
          }

          if (data.type === 'SNAPSHOT') {
            console.log('[useOrderBook] Processing SNAPSHOT with', data.bids?.length, 'bids and', data.asks?.length, 'asks');
            bidsMapRef.current.clear();
            asksMapRef.current.clear();

            if (data.bids) {
              data.bids.forEach((level) => {
                if (parseFloat(level.qty) > 0) {
                  bidsMapRef.current.set(level.px, level.qty);
                }
              });
            }

            if (data.asks) {
              data.asks.forEach((level) => {
                if (parseFloat(level.qty) > 0) {
                  asksMapRef.current.set(level.px, level.qty);
                }
              });
            }

            console.log('[useOrderBook] After SNAPSHOT processing:', bidsMapRef.current.size, 'bids,', asksMapRef.current.size, 'asks');
            updateDisplayState();
          } else if (data.type === 'UPDATE') {
            if (data.bids) {
              data.bids.forEach((level) => {
                if (parseFloat(level.qty) === 0) {
                  bidsMapRef.current.delete(level.px);
                } else {
                  bidsMapRef.current.set(level.px, level.qty);
                }
              });
            }

            if (data.asks) {
              data.asks.forEach((level) => {
                if (parseFloat(level.qty) === 0) {
                  asksMapRef.current.delete(level.px);
                } else {
                  asksMapRef.current.set(level.px, level.qty);
                }
              });
            }
          }
        } catch (error) {
          console.error('[useOrderBook] Failed to parse message:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('[useOrderBook] WebSocket error:', error);
        if (!isCleaningUpRef.current && ws === wsRef.current) {
          setConnectionStatus('error');
        }
      };

      ws.onclose = () => {
        console.log('[useOrderBook] WebSocket closed');
        if (ws === wsRef.current) {
          wsRef.current = null;
        }

        if (isCleaningUpRef.current) {
          return;
        }

        setConnectionStatus('disconnected');

        if (currentParamsRef.current.wsUrl === wsUrl && currentParamsRef.current.symbol === symbol) {
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      console.log('[useOrderBook] Cleanup triggered');
      isCleaningUpRef.current = true;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [wsUrl, symbol, updateDisplayState]);

  useEffect(() => {
    updateIntervalRef.current = setInterval(updateDisplayState, UI_UPDATE_INTERVAL_MS);

    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current);
        updateIntervalRef.current = null;
      }
    };
  }, [updateDisplayState]);

  return {
    bids,
    asks,
    spread,
    connectionStatus,
    lastUpdateTime,
  };
};
