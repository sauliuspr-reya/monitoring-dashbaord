import { useState } from 'react';
import Navbar from '@/components/Navbar';
import ReplicationLogs from '@/components/ReplicationLogs';

export default function LogsPage() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(10000);

  return (
    <>
      <Navbar />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Replication Logs</h1>
          <p className="text-gray-600 mt-2">
            Real-time logs from all replication subscriptions, workers, and sync processes
          </p>
        </div>

        {/* Controls */}
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="autoRefresh"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="w-4 h-4"
              />
              <label htmlFor="autoRefresh" className="text-sm text-gray-700">
                Auto-refresh
              </label>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-700">Interval:</label>
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(parseInt(e.target.value, 10))}
                className="px-2 py-1 border border-gray-300 rounded text-sm"
                disabled={!autoRefresh}
              >
                <option value={5000}>5 seconds</option>
                <option value={10000}>10 seconds</option>
                <option value={30000}>30 seconds</option>
                <option value={60000}>1 minute</option>
              </select>
            </div>
          </div>
        </div>

        {/* Logs Component */}
        <ReplicationLogs
          autoRefresh={autoRefresh}
          refreshInterval={refreshInterval}
          maxHeight="calc(100vh - 300px)"
        />
      </div>
    </>
  );
}
