import { useState, useEffect } from 'react';

interface LogEntry {
  timestamp: string;
  subscriptionName: string;
  level: 'info' | 'warning' | 'error';
  category: 'worker' | 'sync' | 'conflict' | 'error' | 'performance';
  message: string;
  details?: any;
  tableName?: string;
}

interface TableStatus {
  tableName: string;
  sourceRowCount: number;
  targetRowCount: number;
  rowDiff: number;
  rateOfChange: number | null;
  rateOfChangeInterval: string;
  status: string;
  hasReplicationRisk: boolean;
  isSafeToReplicate: boolean;
  sourceTableSize?: number;
  sourceIndexSize?: number;
  sourceTotalSize?: number;
  targetTableSize?: number;
  targetIndexSize?: number;
  targetTotalSize?: number;
  isEstimate?: boolean;
  writersOnSource?: string[];
  writersOnTarget?: string[];
}

interface ReplicationStatusProps {
  subscriptionId: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
  defaultTimeRange?: string;
}

export default function ReplicationStatus({
  subscriptionId,
  autoRefresh = true,
  refreshInterval = 300000, // Default: 5 minutes (300000ms) instead of 15 seconds
  defaultTimeRange = '1h'
}: ReplicationStatusProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tables, setTables] = useState<TableStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingTables, setLoadingTables] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [refreshing, setRefreshing] = useState(false); // Track background refresh (don't show loading)
  const [error, setError] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [expandedLog, setExpandedLog] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<string>(defaultTimeRange);
  const [rateOfChangeTimeframe, setRateOfChangeTimeframe] = useState<string>('1h');
  const [activeTab, setActiveTab] = useState<'overview' | 'tables' | 'logs'>('overview');

  const loadData = async (isBackgroundRefresh: boolean = false) => {
    // Add timeout to prevent infinite loading (60 seconds max)
    const timeoutId = setTimeout(() => {
      if (!isBackgroundRefresh) {
        console.error('[ReplicationStatus] Request timeout after 60 seconds');
        setError('Request timed out. The database may be slow or overloaded.');
        setLoading(false);
        setLoadingLogs(false);
        setLoadingTables(false);
      }
      setRefreshing(false);
    }, 60000);

    try {
      // Only show loading state on initial load, not background refreshes
      if (!isBackgroundRefresh) {
        setError(null);
        setLoadingLogs(true);
        setLoadingTables(true);
      } else {
        setRefreshing(true);
      }
      
      // Load logs and tables in parallel
      // Use current timeframe value (may have changed since component render)
      const currentTimeframe = rateOfChangeTimeframe;
      
      // Create abort controllers for timeout
      const logsAbortController = new AbortController();
      const tablesAbortController = new AbortController();
      const logsTimeout = setTimeout(() => logsAbortController.abort(), 55000);
      const tablesTimeout = setTimeout(() => tablesAbortController.abort(), 55000);
      
      const [logsRes, tablesRes] = await Promise.all([
        fetch(`/api/subscriptions/${subscriptionId}/logs`, {
          signal: logsAbortController.signal,
        }).catch((err) => {
          if (err.name === 'AbortError') {
            console.error('[ReplicationStatus] Logs request timed out after 55 seconds');
          } else {
            console.error('[ReplicationStatus] Failed to load logs:', err);
          }
          return null;
        }).finally(() => clearTimeout(logsTimeout)),
        fetch(`/api/subscriptions/${subscriptionId}/tables?timeframe=${currentTimeframe}`, {
          signal: tablesAbortController.signal,
        }).catch((err) => {
          if (err.name === 'AbortError') {
            console.error('[ReplicationStatus] Tables request timed out after 55 seconds');
          } else {
            console.error('[ReplicationStatus] Failed to load tables:', err);
          }
          return null;
        }).finally(() => clearTimeout(tablesTimeout))
      ]);

      // Handle logs response
      if (logsRes?.ok) {
        const logsData = await logsRes.json();
        setLogs(logsData.logs || []);
      } else if (logsRes) {
        console.warn('[ReplicationStatus] Logs request failed:', logsRes.status, logsRes.statusText);
      }
      setLoadingLogs(false);

      // Handle tables response
      if (tablesRes?.ok) {
        const tablesData = await tablesRes.json();
        setTables(tablesData.tables || []);
      } else if (tablesRes) {
        // Request completed but with error status
        const errorData = await tablesRes.json().catch(() => ({ error: 'Unknown error' }));
        console.error('[ReplicationStatus] Tables request failed:', tablesRes.status, errorData.error || errorData.message);
        setError(`Failed to load tables: ${errorData.error || errorData.message || tablesRes.statusText}`);
      } else {
        // Request failed (network error, etc.)
        console.error('[ReplicationStatus] Tables request failed: Network error or request was null');
        setError('Failed to load tables: Network error or request timeout');
      }
      setLoadingTables(false);
    } catch (err: any) {
      console.error('[ReplicationStatus] Error in loadData:', err);
      setError(err.message || 'Failed to load data');
      setLoadingLogs(false);
      setLoadingTables(false);
    } finally {
      clearTimeout(timeoutId);
      if (!isBackgroundRefresh) {
        setLoading(false);
      }
      setRefreshing(false);
    }
  };

  // Initial load - only when subscriptionId changes
  useEffect(() => {
    loadData(false); // Initial load, show loading state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId]);

  // Manual refresh when timeframe changes (user action, not auto-refresh)
  useEffect(() => {
    // Only refresh if we already have data (not on initial load)
    if (logs.length > 0 || tables.length > 0) {
      loadData(false); // User changed timeframe, show loading briefly
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateOfChangeTimeframe]); // Only refresh when user changes timeframe

  // Background refresh - separate effect that doesn't trigger on timeframe changes
  useEffect(() => {
    if (!autoRefresh) return;
    
    // Don't start refresh immediately - wait for initial load to complete
    // Only refresh if we already have data (not on initial load)
    if (logs.length === 0 && tables.length === 0) {
      return; // Wait for initial load
    }

    const interval = setInterval(() => {
      loadData(true); // Background refresh, don't show loading state
    }, refreshInterval);
    
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, refreshInterval, subscriptionId]); // Only depend on these, not timeRange/timeframe

  const filteredLogs = logs.filter(log => {
    if (filterLevel !== 'all' && log.level !== filterLevel) return false;
    if (filterCategory !== 'all' && log.category !== filterCategory) return false;
    return true;
  });

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-600 bg-red-50 border-red-200';
      case 'warning': return 'text-yellow-600 bg-yellow-50 border-yellow-200';
      case 'info': return 'text-blue-600 bg-blue-50 border-blue-200';
      default: return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'error':
        return '🔴';
      case 'warning':
        return '⚠️';
      default:
        return 'ℹ️';
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const formatRateOfChange = (rate: number | null | undefined, interval: string | undefined) => {
    if (rate === null || rate === undefined) return '—';
    const absRate = Math.abs(rate);
    const sign = rate > 0 ? '+' : '';
    
    if (absRate < 1) {
      return `${sign}${rate.toFixed(2)} rows/min`;
    } else if (absRate < 60) {
      return `${sign}${Math.round(rate)} rows/min`;
    } else {
      const perHour = rate * 60;
      if (perHour < 1000) {
        return `${sign}${Math.round(perHour)} rows/hr`;
      } else {
        return `${sign}${(perHour / 1000).toFixed(1)}k rows/hr`;
      }
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleString();
  };

  const summary = {
    totalLogs: logs.length,
    errors: logs.filter(l => l.level === 'error').length,
    warnings: logs.filter(l => l.level === 'warning').length,
    totalTables: tables.length,
    safeTables: tables.filter(t => t.isSafeToReplicate).length,
    atRiskTables: tables.filter(t => t.hasReplicationRisk).length,
    syncedTables: tables.filter(t => t.status === 'synced').length,
    laggingTables: tables.filter(t => t.status === 'lagging').length,
  };

  // Show loading only on initial load when nothing has loaded yet
  if (loading && logs.length === 0 && tables.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="text-center text-gray-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow">
      {/* Header with Tabs */}
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Replication Status</h2>
          <button
            onClick={() => loadData(false)}
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'overview'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('tables')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'tables'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Tables ({tables.length})
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'logs'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Logs ({logs.length})
          </button>
        </div>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="p-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-50 p-4 rounded-lg">
              <div className="text-xs text-gray-500 mb-1">Tables</div>
              <div className="text-2xl font-bold">{summary.totalTables}</div>
              <div className="text-xs text-gray-600 mt-1">
                ✅ Safe: {summary.safeTables} | ⚠️ At Risk: {summary.atRiskTables}
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg">
              <div className="text-xs text-gray-500 mb-1">Sync Status</div>
              <div className="text-2xl font-bold text-green-600">{summary.syncedTables}</div>
              <div className="text-xs text-gray-600 mt-1">
                Synced | {summary.laggingTables} Lagging
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg">
              <div className="text-xs text-gray-500 mb-1">Logs</div>
              <div className="text-2xl font-bold">{summary.totalLogs}</div>
              <div className="text-xs text-gray-600 mt-1">
                {summary.errors} Errors | {summary.warnings} Warnings
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg">
              <div className="text-xs text-gray-500 mb-1">Rate of Change</div>
              <div className="text-sm text-gray-600">
                <select
                  value={rateOfChangeTimeframe}
                  onChange={(e) => setRateOfChangeTimeframe(e.target.value)}
                  className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="1m">1 minute</option>
                  <option value="5m">5 minutes</option>
                  <option value="10m">10 minutes</option>
                  <option value="30m">30 minutes</option>
                  <option value="1h">1 hour</option>
                  <option value="6h">6 hours</option>
                  <option value="24h">24 hours</option>
                </select>
              </div>
            </div>
          </div>

          {/* Recent Activity */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Recent Logs */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Recent Logs</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {filteredLogs.slice(0, 5).map((log, index) => (
                  <div
                    key={index}
                    className={`p-3 rounded border ${getLevelColor(log.level)}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-sm">{getLevelIcon(log.level)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-500 mb-1">
                          {formatTimestamp(log.timestamp)} • {log.category}
                        </div>
                        <div className="text-sm font-medium">{log.message}</div>
                      </div>
                    </div>
                  </div>
                ))}
                {filteredLogs.length === 0 && (
                  <div className="text-center text-gray-500 text-sm py-4">No logs found</div>
                )}
              </div>
            </div>

            {/* Table Status Summary */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Table Status</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {tables.slice(0, 5).map((table, index) => (
                  <div
                    key={index}
                    className={`p-3 rounded border ${
                      table.hasReplicationRisk
                        ? 'bg-red-50 border-red-200'
                        : table.isSafeToReplicate
                        ? 'bg-green-50 border-green-200'
                        : 'bg-gray-50 border-gray-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {table.tableName}
                        </div>
                        <div className="text-xs text-gray-600 mt-1">
                          {table.sourceRowCount.toLocaleString()} → {table.targetRowCount.toLocaleString()}
                          {table.rowDiff !== 0 && (
                            <span className={table.rowDiff > 0 ? 'text-red-600' : 'text-green-600'}>
                              {' '}({table.rowDiff > 0 ? '+' : ''}{table.rowDiff.toLocaleString()})
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`text-xs font-medium ${
                          table.rateOfChange && table.rateOfChange > 0
                            ? 'text-red-600'
                            : table.rateOfChange && table.rateOfChange < 0
                            ? 'text-green-600'
                            : 'text-gray-600'
                        }`}>
                          {formatRateOfChange(table.rateOfChange, table.rateOfChangeInterval)}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">{table.status}</div>
                      </div>
                    </div>
                  </div>
                ))}
                {tables.length === 0 && (
                  <div className="text-center text-gray-500 text-sm py-4">No tables found</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tables Tab */}
      {activeTab === 'tables' && (
        <div className="p-6">
          {loadingTables && tables.length === 0 && (
            <div className="text-center py-12 text-gray-600">
              <div className="text-lg mb-2">Loading tables...</div>
              <div className="text-sm text-gray-500">This may take a moment for large subscriptions</div>
            </div>
          )}
          {!loadingTables && tables.length === 0 && !error && (
            <div className="text-center py-12 text-gray-500">No tables found</div>
          )}
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="text-red-800 font-medium">Error Loading Tables</div>
              <div className="text-red-600 text-sm mt-1">{error}</div>
            </div>
          )}
          {!loadingTables && tables.length > 0 && (
          <>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-4 text-sm text-gray-600">
              <span>✅ Safe: {summary.safeTables}</span>
              <span className={summary.atRiskTables > 0 ? 'text-red-600 font-semibold' : ''}>
                ⚠️ At Risk: {summary.atRiskTables}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600">Rate of Change:</label>
              <select
                value={rateOfChangeTimeframe}
                onChange={(e) => setRateOfChangeTimeframe(e.target.value)}
                className="px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="1m">1 minute</option>
                <option value="5m">5 minutes</option>
                <option value="10m">10 minutes</option>
                <option value="30m">30 minutes</option>
                <option value="1h">1 hour</option>
                <option value="6h">6 hours</option>
                <option value="24h">24 hours</option>
              </select>
              {tables.length > 0 && (
                <button
                  onClick={() => {
                    // Export to CSV
                    const headers = [
                      'Table Name',
                      'Source Rows',
                      'Target Rows',
                      'Row Diff',
                      'Rate of Change',
                      'Status',
                      'Safety'
                    ];
                    const rows = tables.map(table => [
                      table.tableName,
                      table.sourceRowCount || 0,
                      table.targetRowCount || 0,
                      table.rowDiff || 0,
                      formatRateOfChange(table.rateOfChange, table.rateOfChangeInterval),
                      table.status || 'unknown',
                      table.hasReplicationRisk ? 'Unsafe' : table.isSafeToReplicate ? 'Safe' : '—'
                    ]);
                    const csvContent = [
                      headers.join(','),
                      ...rows.map(row => 
                        row.map(cell => {
                          const cellStr = String(cell);
                          if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
                            return `"${cellStr.replace(/"/g, '""')}"`;
                          }
                          return cellStr;
                        }).join(',')
                      ),
                    ].join('\n');
                    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                    const link = document.createElement('a');
                    const url = URL.createObjectURL(blob);
                    link.setAttribute('href', url);
                    link.setAttribute('download', `tables_${new Date().toISOString().split('T')[0]}.csv`);
                    link.style.visibility = 'hidden';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                  }}
                  className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 font-medium"
                  title="Export tables to CSV"
                >
                  📥 Export CSV
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Table</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Source</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Target</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Diff</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Rate of Change</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Size</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Writers</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Safety</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {tables.map((table, index) => (
                  <tr
                    key={index}
                    className={`hover:bg-gray-50 ${
                      table.hasReplicationRisk ? 'bg-red-50 border-l-4 border-red-500' : ''
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-900">
                      {table.hasReplicationRisk && <span className="text-red-600 mr-1">⚠️</span>}
                      {table.tableName}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                      <div className="flex flex-col items-end">
                        <span>{table.sourceRowCount.toLocaleString()}</span>
                        {table.isEstimate && (
                          <span className="text-xs text-gray-400" title="Estimate (reltuples) - may be stale after restore. Run ANALYZE to update.">
                            ~
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                      <div className="flex flex-col items-end">
                        <span>{table.targetRowCount.toLocaleString()}</span>
                        {table.isEstimate && (
                          <span className="text-xs text-gray-400" title="Estimate (reltuples) - may be stale after restore. Run ANALYZE to update.">
                            ~
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={`px-4 py-3 whitespace-nowrap text-sm text-right ${
                      table.rowDiff > 0 ? 'text-red-600' : table.rowDiff < 0 ? 'text-yellow-600' : 'text-gray-600'
                    }`}>
                      {table.rowDiff !== 0 ? (table.rowDiff > 0 ? '+' : '') + table.rowDiff.toLocaleString() : '0'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right">
                      <span className={`${
                        table.rateOfChange && table.rateOfChange > 0
                          ? 'text-red-600 font-medium'
                          : table.rateOfChange && table.rateOfChange < 0
                          ? 'text-green-600 font-medium'
                          : 'text-gray-600'
                      }`}>
                        {formatRateOfChange(table.rateOfChange, table.rateOfChangeInterval)}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-600">
                      {table.sourceTotalSize ? (
                        <div className="flex flex-col items-end">
                          <span title="Table + Indexes">{formatBytes(table.sourceTotalSize)}</span>
                          {table.sourceIndexSize && table.sourceIndexSize > 0 && (
                            <span className="text-xs text-gray-500" title="Index size">
                              ({formatBytes(table.sourceIndexSize)} idx)
                            </span>
                          )}
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      <div className="flex flex-col gap-1">
                        {table.writersOnSource && table.writersOnSource.length > 0 && (
                          <div className="flex items-center gap-1">
                            <span className="px-1.5 py-0.5 bg-orange-100 text-orange-800 text-xs rounded font-medium">
                              AWS
                            </span>
                            <span className="text-xs text-gray-600">
                              {table.writersOnSource.join(', ')}
                            </span>
                          </div>
                        )}
                        {table.writersOnTarget && table.writersOnTarget.length > 0 && (
                          <div className="flex items-center gap-1">
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-800 text-xs rounded font-medium">
                              GCP
                            </span>
                            <span className="text-xs text-gray-600">
                              {table.writersOnTarget.join(', ')}
                            </span>
                          </div>
                        )}
                        {(!table.writersOnSource || table.writersOnSource.length === 0) && 
                         (!table.writersOnTarget || table.writersOnTarget.length === 0) && (
                          <span className="text-gray-400 text-xs">No writers</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      {table.hasReplicationRisk ? (
                        <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded font-medium">
                          ⚠️ Unsafe
                        </span>
                      ) : table.isSafeToReplicate ? (
                        <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded font-medium">
                          ✅ Safe
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      <span
                        className={`px-2 py-1 rounded text-xs font-medium ${
                          table.status === 'synced'
                            ? 'bg-green-100 text-green-800'
                            : table.status === 'lagging'
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {table.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
          )}
          {refreshing && tables.length > 0 && (
            <div className="mt-4 text-xs text-gray-500 text-center">🔄 Refreshing in background...</div>
          )}
        </div>
      )}

      {/* Logs Tab */}
      {activeTab === 'logs' && (
        <div>
          {/* Filters */}
          <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex flex-wrap gap-4">
              <div>
                <label className="text-sm text-gray-600 mr-2">Time Range:</label>
                <select
                  value={timeRange}
                  onChange={(e) => setTimeRange(e.target.value)}
                  className="px-2 py-1 border border-gray-300 rounded text-sm"
                >
                  <option value="5m">Last 5 minutes</option>
                  <option value="15m">Last 15 minutes</option>
                  <option value="30m">Last 30 minutes</option>
                  <option value="1h">Last 1 hour</option>
                  <option value="3h">Last 3 hours</option>
                  <option value="6h">Last 6 hours</option>
                  <option value="12h">Last 12 hours</option>
                  <option value="24h">Last 24 hours</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-gray-600 mr-2">Level:</label>
                <select
                  value={filterLevel}
                  onChange={(e) => setFilterLevel(e.target.value)}
                  className="px-2 py-1 border border-gray-300 rounded text-sm"
                >
                  <option value="all">All</option>
                  <option value="error">Error</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-gray-600 mr-2">Category:</label>
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="px-2 py-1 border border-gray-300 rounded text-sm"
                >
                  <option value="all">All</option>
                  <option value="worker">Worker</option>
                  <option value="sync">Sync</option>
                  <option value="conflict">Conflict</option>
                  <option value="error">Error</option>
                  <option value="performance">Performance</option>
                </select>
              </div>
            </div>
          </div>

          {/* Logs List */}
          <div className="overflow-y-auto max-h-96">
            {filteredLogs.length === 0 ? (
              <div className="p-6 text-center text-gray-600">No logs found</div>
            ) : (
              <div className="divide-y divide-gray-200">
                {filteredLogs.map((log, index) => (
                  <div
                    key={index}
                    className={`p-4 hover:bg-gray-50 cursor-pointer border-l-4 ${getLevelColor(log.level)}`}
                    onClick={() => setExpandedLog(expandedLog === index ? null : index)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 mt-0.5 text-lg">
                        {getLevelIcon(log.level)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="px-2 py-0.5 text-xs font-medium rounded bg-white bg-opacity-50">
                            {log.category}
                          </span>
                          <span className="text-xs text-gray-500">
                            {formatTimestamp(log.timestamp)}
                          </span>
                          {log.tableName && (
                            <span className="text-xs text-gray-500 font-mono">
                              → {log.tableName}
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-medium text-gray-900">
                          {log.message}
                        </div>
                        {expandedLog === index && log.details && (
                          <div className="mt-2 p-2 bg-gray-100 rounded text-xs font-mono overflow-x-auto">
                            <pre>{JSON.stringify(log.details, null, 2)}</pre>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="px-6 py-4 bg-red-50 border-t border-red-200">
          <div className="text-sm text-red-600">Error: {error}</div>
        </div>
      )}
    </div>
  );
}

