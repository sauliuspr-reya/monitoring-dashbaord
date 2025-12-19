export interface PriceLevel {
  px: string;
  qty: string;
}

export interface DepthData {
  symbol: string;
  type: 'SNAPSHOT' | 'UPDATE';
  bids: PriceLevel[];
  asks: PriceLevel[];
  updatedAt: number;
}

export interface DepthChannelDataMessage {
  type: 'channel_data';
  timestamp: number;
  channel: string;
  data: DepthData;
}

export interface DepthSubscribedMessage {
  type: 'subscribed';
  channel: string;
  contents: DepthData;
}

export type DepthMessage = DepthChannelDataMessage | DepthSubscribedMessage;

export interface SpotMarketDefinition {
  spotMarketId: number;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

export type Environment = 'staging' | 'cronos';

export const WS_URLS: Record<Environment, string> = {
  staging: 'wss://websocket-staging.reya.xyz',
  cronos: 'wss://websocket-testnet.reya.xyz',
};

export const API_URLS: Record<Environment, string> = {
  staging: 'https://api-staging.reya.xyz',
  cronos: 'https://api-cronos.reya.xyz',
};

export interface DisplayLevel extends PriceLevel {
  total: string;
}

export interface Spread {
  value: string;
  percent: string;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
