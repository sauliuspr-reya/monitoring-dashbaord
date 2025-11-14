import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Navbar from '@/components/Navbar';

interface ServiceDetail {
  service: string;
  operation: string;
  count: number;
  lastWriteTime?: Date;
}

interface DatabaseLocation {
  type: 'source' | 'target';
  provider: 'aws' | 'gcp' | 'unknown';
  host?: string;
  label: string;
}

interface TableInfo {
  tableName: string;
  schema: string;
  table: string;
  sourceRowCount: number;
  targetRowCount: number;
  rowDiff: number;
  sourceSize: number;
  targetSize: number;
  subscriptions: string[];
  replicationStatus?: 'active' | 'stopped' | 'error' | 'none'; // Actual replication health status
  goldskyIndexed: boolean;
  goldskyPipeline?: string;
  services?: string[];
  serviceDetails?: ServiceDetail[]; // Detailed service write information
  hasReplicationRisk?: boolean; // ⚠️ Active writers + replication = PK conflict risk
  hasActiveWriters?: boolean;
  shouldReplicate?: boolean; // ✅ Safe to replicate (only source writers or none)
  writersOnSource?: string[]; // Services writing to AWS
  writersOnTarget?: string[]; // Services writing to GCP
  writersOnBoth?: boolean; // True if writers on both sides
  isEstimate?: boolean;
  rateOfChange1Hour?: number | null; // Rows per minute over last 1 hour
  rateOfChange24Hour?: number | null; // Rows per minute over last 24 hours
  loading?: boolean; // Flag to indicate stats are still being loaded
  lastBackupDate?: string;
  lastBackupId?: string;
  lastBackupTables?: string[];
}

export default function TablesPage() {
  const router = useRouter();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [replicationFilter, setReplicationFilter] = useState<string>('all'); // 'all', 'safe', 'unsafe', 'both-writers'
  const [riskFilter, setRiskFilter] = useState<string>('all'); // 'all', 'risk', 'safe'
  const [sortBy, setSortBy] = useState<'table' | 'size' | 'rows' | 'subscriptions' | 'writers' | 'awsWriters' | 'gcpWriters' | 'diff' | 'rateOfChange' | 'replicationStatus' | 'safetyStatus'>('table');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadTables();
    const interval = setInterval(loadTables, 300000); // Refresh every 5 minutes
    return () => clearInterval(interval);
  }, []);

  const loadTables = async (showLoading = true) => {
    try {
      if (showLoading) {
        setLoading(true);
      }
      const res = await fetch('/api/tables/all');
      if (!res.ok) {
        throw new Error(`Failed to load tables: ${res.statusText}`);
      }
      const data = await res.json();
      setTables(data.tables || []);
      setLoading(false);
      setError(null);
      
      // If stats are still loading, poll for updates
      if (data.loadingComplete === false) {
        // Poll every 2 seconds until all stats are loaded
        const pollInterval = setInterval(async () => {
          try {
            const pollRes = await fetch('/api/tables/all?refresh=true');
            if (pollRes.ok) {
              const pollData = await pollRes.json();
              setTables(pollData.tables || []);
              if (pollData.loadingComplete === true) {
                clearInterval(pollInterval);
              }
            }
          } catch (err) {
            clearInterval(pollInterval);
          }
        }, 2000);
        
        // Stop polling after 5 minutes max
        setTimeout(() => clearInterval(pollInterval), 5 * 60 * 1000);
      }
    } catch (err: any) {
      console.error('Error loading tables:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const formatRateOfChange = (rate: number | null | undefined) => {
    if (rate === null || rate === undefined) return '—';
    // Don't show if rate is effectively zero
    if (Math.abs(rate) < 0.01) return '~0';
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

  const handleSort = (column: typeof sortBy) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('asc');
    }
  };

  const filteredAndSortedTables = [...tables]
    .filter(table => {
      // Text filter
      const matchesText = filter === '' || 
        table.table.toLowerCase().includes(filter.toLowerCase()) ||
        table.subscriptions.some(s => s.toLowerCase().includes(filter.toLowerCase()));
      
      // Database location filter
      // Replication filter (safe to replicate vs unsafe)
      const matchesReplication = replicationFilter === 'all' ||
        (replicationFilter === 'safe' && table.shouldReplicate) ||
        (replicationFilter === 'unsafe' && !table.shouldReplicate) ||
        (replicationFilter === 'both-writers' && table.writersOnBoth);
      
      // Replication risk filter
      const matchesRisk = riskFilter === 'all' ||
        (riskFilter === 'risk' && table.hasReplicationRisk) ||
        (riskFilter === 'safe' && !table.hasReplicationRisk);
      
      return matchesText && matchesReplication && matchesRisk;
    })
    .sort((a, b) => {
      let aVal: any, bVal: any;
      
      switch (sortBy) {
        case 'table':
          aVal = a.table.toLowerCase();
          bVal = b.table.toLowerCase();
          break;
        case 'size':
          aVal = a.sourceSize;
          bVal = b.sourceSize;
          break;
        case 'rows':
          aVal = a.sourceRowCount;
          bVal = b.sourceRowCount;
          break;
        case 'subscriptions':
          aVal = a.subscriptions.length;
          bVal = b.subscriptions.length;
          break;
        case 'writers':
          aVal = (a.writersOnSource?.length || 0) + (a.writersOnTarget?.length || 0);
          bVal = (b.writersOnSource?.length || 0) + (b.writersOnTarget?.length || 0);
          break;
        case 'awsWriters':
          aVal = a.writersOnSource?.length || 0;
          bVal = b.writersOnSource?.length || 0;
          break;
        case 'gcpWriters':
          aVal = a.writersOnTarget?.length || 0;
          bVal = b.writersOnTarget?.length || 0;
          break;
        case 'diff':
          aVal = a.rowDiff;
          bVal = b.rowDiff;
          break;
        case 'rateOfChange':
          // Sort by 1-hour rate
          aVal = a.rateOfChange1Hour ?? -Infinity;
          bVal = b.rateOfChange1Hour ?? -Infinity;
          break;
        case 'replicationStatus':
          // Sort by actual replication status: active=0, stopped=1, error=2, none=3
          const statusOrder = { 'active': 0, 'stopped': 1, 'error': 2, 'none': 3 };
          aVal = statusOrder[a.replicationStatus || 'none'] ?? 3;
          bVal = statusOrder[b.replicationStatus || 'none'] ?? 3;
          break;
        case 'safetyStatus':
          // Unsafe = 0, Safe = 1, None = 2
          aVal = a.writersOnBoth ? 0 : a.shouldReplicate ? 1 : 2;
          bVal = b.writersOnBoth ? 0 : b.shouldReplicate ? 1 : 2;
          break;
        default:
          return 0;
      }
      
      if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

  const SortIcon = ({ column }: { column: typeof sortBy }) => {
    if (sortBy !== column) return null;
    return sortOrder === 'asc' ? '↑' : '↓';
  };

  const toggleTableSelection = (tableName: string) => {
    const newSelected = new Set(selectedTables);
    if (newSelected.has(tableName)) {
      newSelected.delete(tableName);
    } else {
      newSelected.add(tableName);
    }
    setSelectedTables(newSelected);
  };

  const selectAllFiltered = () => {
    const allFiltered = new Set(filteredAndSortedTables.map(t => t.table));
    setSelectedTables(allFiltered);
  };

  const deselectAll = () => {
    setSelectedTables(new Set());
  };

  const handleCreateSubscription = () => {
    if (selectedTables.size === 0) {
      alert('Please select at least one table');
      return;
    }

    // Navigate to subscription creation page with selected tables
    const tablesArray = Array.from(selectedTables);
    router.push({
      pathname: '/subscriptions/new',
      query: { tables: tablesArray.join(',') },
    });
  };

  const handleTableBackup = (tableName: string) => {
    router.push({
      pathname: '/backup',
      query: { tables: tableName },
    });
  };

  const handleTableSubscribe = (tableName: string) => {
    router.push({
      pathname: '/subscriptions/new',
      query: { tables: tableName },
    });
  };

  const exportToCSV = () => {
    // Prepare CSV headers
    const headers = [
      'Table Name',
      'Source Rows',
      'Target Rows',
      'Row Diff',
      'Source Size (MB)',
      'Target Size (MB)',
      'Subscriptions',
      'Goldsky Indexed',
      'Goldsky Pipeline',
      'Services',
      'AWS Writers',
      'GCP Writers',
      'Writers on Both',
      'Replication Risk',
      'Should Replicate',
      'Growth Rate (rows/min)',
    ];

    // Prepare CSV rows
    const rows = filteredAndSortedTables.map(table => [
      table.table,
      table.sourceRowCount,
      table.targetRowCount,
      table.rowDiff,
      (table.sourceSize / (1024 * 1024)).toFixed(2),
      (table.targetSize / (1024 * 1024)).toFixed(2),
      table.subscriptions.join('; '),
      table.goldskyIndexed ? 'Yes' : 'No',
      table.goldskyPipeline || '',
      table.services?.join('; ') || '',
      table.writersOnSource?.join('; ') || '',
      table.writersOnTarget?.join('; ') || '',
      table.writersOnBoth ? 'Yes' : 'No',
      table.hasReplicationRisk ? 'Yes' : 'No',
      table.shouldReplicate ? 'Yes' : 'No',
      table.rateOfChange1Hour?.toFixed(2) || '',
    ]);

    // Convert to CSV string
    const csvContent = [
      headers.join(','),
      ...rows.map(row => 
        row.map(cell => {
          // Escape cells containing commas, quotes, or newlines
          const cellStr = String(cell);
          if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
            return `"${cellStr.replace(/"/g, '""')}"`;
          }
          return cellStr;
        }).join(',')
      ),
    ].join('\n');

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `tables_export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-gray-600">Loading tables...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-6 sm:px-8 lg:px-12 py-8">

        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Tables</h1>
          <p className="mt-2 text-gray-600">
            Identify which tables need to be replicated individually or by domain. View replication status, sizes, indexing, and service dependencies.
          </p>
        </div>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="text-red-800 font-medium">Error</div>
            <div className="text-red-600 mt-1">{error}</div>
          </div>
        )}

        {/* Selection Actions Bar */}
        {selectedTables.size > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-blue-900">
                  {selectedTables.size} table{selectedTables.size !== 1 ? 's' : ''} selected
                </span>
                <button
                  onClick={deselectAll}
                  className="text-sm text-blue-600 hover:text-blue-800 underline"
                >
                  Deselect All
                </button>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    const tablesArray = Array.from(selectedTables);
                    handleTableBackup(tablesArray.join(','));
                  }}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 font-medium"
                >
                  💾 Backup & Restore
                </button>
                <button
                  onClick={handleCreateSubscription}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
                >
                  🔄 Subscribe for Replication
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Filters and Stats */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between mb-4">
            <div className="flex-1 w-full md:w-auto">
              <input
                type="text"
                placeholder="Search tables or subscriptions..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={exportToCSV}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 font-medium"
                title="Export filtered tables to CSV"
              >
                📥 Export CSV
              </button>
              <button
                onClick={selectAllFiltered}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                Select All (Filtered)
              </button>
              {selectedTables.size > 0 && (
                <button
                  onClick={deselectAll}
                  className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                >
                  Deselect All
                </button>
              )}
            </div>
            <div className="flex gap-3 items-center flex-wrap">
              <label className="text-sm text-gray-700">
                Replication:
                <select
                  value={replicationFilter}
                  onChange={(e) => setReplicationFilter(e.target.value)}
                  className="ml-2 px-3 py-1.5 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All</option>
                  <option value="safe">✅ Safe to Replicate</option>
                  <option value="unsafe">Dual Writers</option>
                  <option value="both-writers">Writers on Both Sides</option>
                </select>
              </label>
              <label className="text-sm text-gray-700">
                Replication Risk:
                <select
                  value={riskFilter}
                  onChange={(e) => setRiskFilter(e.target.value)}
                  className="ml-2 px-3 py-1.5 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="all">All</option>
                  <option value="risk">Active Replication + Writers</option>
                  <option value="safe">✓ Safe</option>
                </select>
              </label>
            </div>
            <div className="flex gap-2 text-sm text-gray-600">
              <span>Total: {tables.length}</span>
              <span>•</span>
              <span>With Subscriptions: {tables.filter(t => t.subscriptions.length > 0).length}</span>
              <span>•</span>
              <span className="font-semibold text-orange-600">
                Dual Writers: {tables.filter(t => t.hasReplicationRisk).length}
              </span>
              <span>•</span>
              <span>Goldsky: {tables.filter(t => t.goldskyIndexed).length}</span>
            </div>
          </div>
        </div>

        {/* Tables Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-12">
                    <input
                      type="checkbox"
                      checked={filteredAndSortedTables.length > 0 && filteredAndSortedTables.every(t => selectedTables.has(t.table))}
                      onChange={(e) => {
                        if (e.target.checked) {
                          selectAllFiltered();
                        } else {
                          deselectAll();
                        }
                      }}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('table')}
                  >
                    Table <SortIcon column="table" />
                    <span className="ml-2 text-red-600" title="⚠️ = Active writers + Replication = PK conflict risk">⚠️</span>
                  </th>
                  <th
                    className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('size')}
                  >
                    Size <SortIcon column="size" />
                  </th>
                  <th
                    className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('rows')}
                  >
                    Source Rows <SortIcon column="rows" />
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Target Rows
                  </th>
                  <th 
                    className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('diff')}
                  >
                    <div className="flex items-center justify-end gap-1">
                      Diff <SortIcon column="diff" />
                    </div>
                  </th>
                  <th 
                    className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('rateOfChange')}
                  >
                    <div className="flex items-center justify-end gap-1">
                      Growth (1h) <SortIcon column="rateOfChange" />
                    </div>
                  </th>
                  <th
                    className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('subscriptions')}
                  >
                    Subscriptions <SortIcon column="subscriptions" />
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('awsWriters')}
                  >
                    <div className="flex items-center gap-1">
                      <span className="px-1.5 py-0.5 bg-orange-100 text-orange-800 text-xs rounded font-medium">AWS</span>
                      Writers <SortIcon column="awsWriters" />
                    </div>
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('gcpWriters')}
                  >
                    <div className="flex items-center gap-1">
                      <span className="px-1.5 py-0.5 bg-blue-100 text-blue-800 text-xs rounded font-medium">GCP</span>
                      Writers <SortIcon column="gcpWriters" />
                    </div>
                  </th>
                  <th
                    className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('replicationStatus')}
                  >
                    Replication Status <SortIcon column="replicationStatus" />
                  </th>
                  <th
                    className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('safetyStatus')}
                  >
                    Safety Status <SortIcon column="safetyStatus" />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Last Backup
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Backup ID
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredAndSortedTables.map((table) => (
                  <tr 
                    key={table.tableName} 
                    className={`hover:bg-gray-50 ${
                      table.hasReplicationRisk ? 'bg-orange-50 border-l-2 border-orange-300' : ''
                    } ${selectedTables.has(table.table) ? 'bg-blue-50' : ''}`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      <input
                        type="checkbox"
                        checked={selectedTables.has(table.table)}
                        onChange={() => toggleTableSelection(table.table)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-sm font-mono text-gray-900">
                        {table.table}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                      {formatBytes(table.sourceSize)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                      {table.sourceRowCount.toLocaleString()}
                      {table.isEstimate && <span className="text-xs text-gray-400 ml-1" title="Approximate count">~</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                      {table.targetRowCount.toLocaleString()}
                    </td>
                    <td className={`px-4 py-3 whitespace-nowrap text-sm text-right ${
                      table.rowDiff > 0 ? 'text-red-600 font-medium' : 
                      table.rowDiff < 0 ? 'text-yellow-600' : 
                      'text-gray-600'
                    }`}>
                      {table.rowDiff !== 0 ? (table.rowDiff > 0 ? '+' : '') + table.rowDiff.toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right">
                      <span className={`${
                        table.rateOfChange1Hour && table.rateOfChange1Hour > 0 
                          ? 'text-red-600 font-medium' 
                          : table.rateOfChange1Hour && table.rateOfChange1Hour < 0
                          ? 'text-green-600 font-medium'
                          : 'text-gray-600'
                      }`}>
                        {formatRateOfChange(table.rateOfChange1Hour)}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      {table.subscriptions.length > 0 ? (
                        <div className="flex flex-wrap gap-1 justify-center">
                          {table.subscriptions.map((sub, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded"
                            >
                              {sub}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">None</span>
                      )}
                    </td>
                    {/* AWS Writers Column */}
                    <td className="px-4 py-3 text-sm">
                      {table.writersOnSource && table.writersOnSource.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {table.writersOnSource.map((writer, idx) => (
                            <span key={idx} className="text-xs text-gray-700">
                              {writer}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    {/* GCP Writers Column */}
                    <td className="px-4 py-3 text-sm">
                      {table.writersOnTarget && table.writersOnTarget.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {table.writersOnTarget.map((writer, idx) => (
                            <span key={idx} className="text-xs text-gray-700">
                              {writer}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    {/* Replication Status Column */}
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      {table.replicationStatus === 'active' ? (
                        <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded font-medium" title="Subscription is enabled and worker is running">
                          ✅ Active
                        </span>
                      ) : table.replicationStatus === 'stopped' ? (
                        <span className="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs rounded font-medium" title="Subscription is enabled but worker is not running">
                          ⏸ Stopped
                        </span>
                      ) : table.replicationStatus === 'error' ? (
                        <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded font-medium" title="Subscription is enabled but worker failed">
                          ❌ Error
                        </span>
                      ) : table.subscriptions && table.subscriptions.length > 0 ? (
                        <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded" title="Table is in subscription but status unknown">
                          ⚠ Unknown
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                          None
                        </span>
                      )}
                    </td>
                    {/* Safety Status Column */}
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      {table.writersOnBoth ? (
                        <span className="px-2 py-1 bg-orange-50 text-orange-700 text-xs rounded">
                          Dual Writers
                        </span>
                      ) : table.shouldReplicate ? (
                        <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded font-medium">
                          ✅ Safe
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                          —
                        </span>
                      )}
                    </td>
                    {/* Last Backup Column */}
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                      {table.lastBackupDate ? (
                        <div className="flex flex-col">
                          <span title={new Date(table.lastBackupDate).toLocaleString()}>
                            {(() => {
                              const date = new Date(table.lastBackupDate);
                              const now = new Date();
                              const diffMs = now.getTime() - date.getTime();
                              const diffMins = Math.floor(diffMs / 60000);
                              const diffHours = Math.floor(diffMs / 3600000);
                              const diffDays = Math.floor(diffMs / 86400000);
                              
                              if (diffMins < 1) return 'Just now';
                              if (diffMins < 60) return `${diffMins}m ago`;
                              if (diffHours < 24) return `${diffHours}h ago`;
                              if (diffDays < 7) return `${diffDays}d ago`;
                              return date.toLocaleDateString();
                            })()}
                          </span>
                          {table.lastBackupTables && table.lastBackupTables.length > 0 && (
                            <span className="text-xs text-gray-500 mt-0.5">
                              {table.lastBackupTables.length} table{table.lastBackupTables.length !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    {/* Backup ID Column */}
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      {table.lastBackupId ? (
                        <span className="font-mono text-blue-600 text-xs" title={table.lastBackupId}>
                          {table.lastBackupId.substring(0, 8)}...
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredAndSortedTables.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              {filter ? 'No tables match your search' : 'No tables found'}
            </div>
          )}
        </div>

        <div className="mt-4 text-sm text-gray-500 text-center">
          Showing {filteredAndSortedTables.length} of {tables.length} tables
        </div>
        </div>
      </div>
    </>
  );
}

