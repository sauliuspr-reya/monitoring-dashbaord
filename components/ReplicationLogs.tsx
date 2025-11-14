import { useState, useEffect, useCallback } from 'react';

interface LogEntry {
  timestamp: string;
  subscriptionName: string;
  level: 'info' | 'warning' | 'error';
  category: 'worker' | 'sync' | 'conflict' | 'error' | 'performance';
  message: string;
  details?: any;
  tableName?: string;
}

interface ReplicationLogsProps {
  subscriptionId?: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
  maxHeight?: string;
  defaultTimeRange?: string;
}

export default function ReplicationLogs({
  subscriptionId,
  autoRefresh = true,
  refreshInterval = 10000,
  maxHeight = '600px',
  defaultTimeRange = '1h'
}: ReplicationLogsProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [expandedLog, setExpandedLog] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<string>(defaultTimeRange);

  const loadLogs = useCallback(async () => {
    try {
      const url = subscriptionId
        ? `/api/subscriptions/${subscriptionId}/logs`
        : `/api/logs/all`;
      
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load logs');
      
      const data = await res.json();
      setLogs(data.logs || []);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [subscriptionId]);

  useEffect(() => {
    loadLogs();

    if (autoRefresh) {
      const interval = setInterval(loadLogs, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [subscriptionId, autoRefresh, refreshInterval, loadLogs]);

  const filteredLogs = logs.filter(log => {
    if (filterLevel !== 'all' && log.level !== filterLevel) return false;
    if (filterCategory !== 'all' && log.category !== filterCategory) return false;
    return true;
  });

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-600 bg-red-50';
      case 'warning': return 'text-yellow-600 bg-yellow-50';
      case 'info': return 'text-blue-600 bg-blue-50';
      default: return 'text-gray-600 bg-gray-50';
    }
  };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'error':
        return (
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        );
      case 'warning':
        return (
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        );
      default:
        return (
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
        );
    }
  };

  const getCategoryBadge = (category: string) => {
    const colors = {
      worker: 'bg-purple-100 text-purple-800',
      sync: 'bg-blue-100 text-blue-800',
      conflict: 'bg-red-100 text-red-800',
      error: 'bg-red-100 text-red-800',
      performance: 'bg-yellow-100 text-yellow-800'
    };
    return colors[category as keyof typeof colors] || 'bg-gray-100 text-gray-800';
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

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="text-center text-gray-600">Loading logs...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="text-center text-red-600">Error: {error}</div>
      </div>
    );
  }

  const summary = {
    total: logs.length,
    errors: logs.filter(l => l.level === 'error').length,
    warnings: logs.filter(l => l.level === 'warning').length,
    info: logs.filter(l => l.level === 'info').length
  };

  return (
    <div className="bg-white rounded-lg shadow">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold text-gray-900">Replication Logs</h2>
          <button
            onClick={loadLogs}
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>

        {/* Summary */}
        <div className="mt-4 grid grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-gray-600">Total</div>
            <div className="text-2xl font-bold">{summary.total}</div>
          </div>
          <div>
            <div className="text-gray-600">Errors</div>
            <div className="text-2xl font-bold text-red-600">{summary.errors}</div>
          </div>
          <div>
            <div className="text-gray-600">Warnings</div>
            <div className="text-2xl font-bold text-yellow-600">{summary.warnings}</div>
          </div>
          <div>
            <div className="text-gray-600">Info</div>
            <div className="text-2xl font-bold text-blue-600">{summary.info}</div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
        <div className="flex flex-wrap gap-4">
          <div>
            <label className="text-sm text-gray-600 mr-2">Time Range:</label>
            <select
              value={timeRange}
              onChange={(e) => {
                setTimeRange(e.target.value);
                loadLogs();
              }}
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
              <option value="48h">Last 48 hours</option>
              <option value="7d">Last 7 days</option>
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
      <div className="overflow-y-auto" style={{ maxHeight }}>
        {filteredLogs.length === 0 ? (
          <div className="p-6 text-center text-gray-600">No logs found</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {filteredLogs.map((log, index) => (
              <div
                key={index}
                className={`p-4 hover:bg-gray-50 cursor-pointer ${getLevelColor(log.level)}`}
                onClick={() => setExpandedLog(expandedLog === index ? null : index)}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5">
                    {getLevelIcon(log.level)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded ${getCategoryBadge(log.category)}`}>
                        {log.category}
                      </span>
                      <span className="text-xs text-gray-500">
                        {formatTimestamp(log.timestamp)}
                      </span>
                      <span className="text-xs text-gray-500 font-mono">
                        {log.subscriptionName}
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
  );
}
