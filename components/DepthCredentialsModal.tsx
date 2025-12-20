import { useState, useEffect } from 'react';
import type { Environment, SpotMarketDefinition } from '@/lib/types/orderbook';

interface DepthCredentialsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStart: (config: DepthStartConfig) => void;
  initialSymbol: string;
  initialEnvironment: Environment;
  markets: SpotMarketDefinition[];
  isLoading: boolean;
}

export interface SpotCredentials {
  spotAccountId: string;
  spotPrivateKey: string;
  spotWalletAddress: string;
}

export interface DepthStartConfig {
  symbol: string;
  environment: Environment;
  credentials: SpotCredentials | null;
}

const ENVIRONMENTS: { value: Environment; label: string }[] = [
  { value: 'staging', label: 'Staging' },
  { value: 'cronos', label: 'Cronos' },
];

export default function DepthCredentialsModal({
  isOpen,
  onClose,
  onStart,
  initialSymbol,
  initialEnvironment,
  markets,
  isLoading,
}: DepthCredentialsModalProps) {
  const [selectedEnvironment, setSelectedEnvironment] = useState<Environment>(initialEnvironment);
  const [selectedSymbol, setSelectedSymbol] = useState(initialSymbol);
  const [spotAccountId, setSpotAccountId] = useState('');
  const [spotPrivateKey, setSpotPrivateKey] = useState('');
  const [spotWalletAddress, setSpotWalletAddress] = useState('');

  // Reset selections when modal opens with new initial values
  useEffect(() => {
    if (isOpen) {
      setSelectedEnvironment(initialEnvironment);
      setSelectedSymbol(initialSymbol);
    }
  }, [isOpen, initialEnvironment, initialSymbol]);

  if (!isOpen) return null;

  const handleStart = () => {
    const credentials = (spotAccountId && spotPrivateKey && spotWalletAddress)
      ? { spotAccountId, spotPrivateKey, spotWalletAddress }
      : null;

    onStart({
      symbol: selectedSymbol,
      environment: selectedEnvironment,
      credentials,
    });
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Start Depth Provider</h3>
        
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Environment
              </label>
              <select
                value={selectedEnvironment}
                onChange={(e) => setSelectedEnvironment(e.target.value as Environment)}
                disabled={isLoading}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {ENVIRONMENTS.map((env) => (
                  <option key={env.value} value={env.value}>
                    {env.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Symbol
              </label>
              <select
                value={selectedSymbol}
                onChange={(e) => setSelectedSymbol(e.target.value)}
                disabled={isLoading || markets.length === 0}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {markets.map((market) => (
                  <option key={market.spotMarketId} value={market.symbol}>
                    {market.symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              SPOT Account ID <span className="text-gray-500 text-xs">(optional)</span>
            </label>
            <input
              type="text"
              value={spotAccountId}
              onChange={(e) => setSpotAccountId(e.target.value)}
              placeholder="e.g., 10000000004 (leave empty for .env default)"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isLoading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              SPOT Private Key <span className="text-gray-500 text-xs">(optional)</span>
            </label>
            <input
              type="password"
              value={spotPrivateKey}
              onChange={(e) => setSpotPrivateKey(e.target.value)}
              placeholder="Private key hex (leave empty for .env default)"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isLoading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              SPOT Wallet Address <span className="text-gray-500 text-xs">(optional)</span>
            </label>
            <input
              type="text"
              value={spotWalletAddress}
              onChange={(e) => setSpotWalletAddress(e.target.value)}
              placeholder="0x... (leave empty for .env default)"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isLoading}
            />
            <p className="mt-1 text-xs text-gray-500">
              Leave all fields empty to use credentials from .env file
            </p>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
            <p className="text-sm text-yellow-800">
              ⚠️ Only one depth provider can run at a time. Starting this will use the selected market and environment.
            </p>
          </div>
        </div>

        <div className="mt-6 flex space-x-3">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={isLoading || !selectedSymbol}
            className="flex-1 px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {isLoading ? 'Starting...' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
