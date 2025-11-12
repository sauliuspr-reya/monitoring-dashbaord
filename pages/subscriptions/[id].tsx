import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ReplicationStatus } from '@/lib/types';
import Navbar from '@/components/Navbar';
import ManageSubscriptionTables from '@/components/ManageSubscriptionTables';
import ReplicationLogs from '@/components/ReplicationLogs';

type SortField = 'table' | 'sourceRowCount' | 'targetRowCount' | 'rowDiff' | 'rateOfChange' | 'size' | 'status';
type SortDirection = 'asc' | 'desc';

export default function SubscriptionDetails() {
  const router = useRouter();
  const { id } = router.query;
  const [subscription, setSubscription] = useState<ReplicationStatus | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sortField, setSortField] = useState<SortField>('table');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showManageTables, setShowManageTables] = useState(false);

  useEffect(() => {
    if (id) {
      loadSubscriptionDetails();
      loadTables();
      const interval = setInterval(() => {
        loadSubscriptionDetails();
        loadTables();
      }, 10000); // Refresh every 10 seconds
      return () => clearInterval(interval);
    }
  }, [id]);

  const loadSubscriptionDetails = async () => {
    if (!id) return;
    
    try {
      const res = await fetch(`/api/groups/${id}/status`);
      if (!res.ok) {
        throw new Error(`Failed to load subscription: ${res.statusText}`);
      }
      const data = await res.json();
      setSubscription(data);
      setLoading(false);
      setError(null);
    } catch (err: any) {
      console.error('Error loading subscription details:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  const loadTables = async () => {
    if (!id) return;
    
    setLoadingTables(true);
    try {
      const res = await fetch(`/api/subscriptions/${id}/tables`);
      if (res.ok) {
        const data = await res.json();
        setTables(data.tables || []);
      }
    } catch (err: any) {
      console.error('Error loading tables:', err);
      // Don't show error for tables, just log it
    } finally {
      setLoadingTables(false);
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

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedTables = [...tables].sort((a, b) => {
    let aVal: any = a[sortField];
    let bVal: any = b[sortField];
    
    // Handle null/undefined values
    if (aVal === null || aVal === undefined) {
      aVal = sortField === 'table' || sortField === 'status' ? '' : -Infinity;
    }
    if (bVal === null || bVal === undefined) {
      bVal = sortField === 'table' || sortField === 'status' ? '' : -Infinity;
    }
    
    // Handle string comparison for table name and status
    if (sortField === 'table' || sortField === 'status') {
      return sortDirection === 'asc' 
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    }
    
    // Handle numeric comparison
    const comparison = (aVal as number) - (bVal as number);
    return sortDirection === 'asc' ? comparison : -comparison;
  });

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <span className="text-gray-400">↕</span>;
    }
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  const exportTablesToCSV = () => {
    if (tables.length === 0) return;

    // Prepare CSV headers
    const headers = [
      'Table Name',
      'Source Rows',
      'Target Rows',
      'Row Diff',
      'Source Size (MB)',
      'Target Size (MB)',
      'Status',
      'Rate of Change (rows/min)',
    ];

    // Prepare CSV rows
    const rows = sortedTables.map(table => [
      table.tableName || table.table,
      table.sourceRowCount || 0,
      table.targetRowCount || 0,
      table.rowDiff || 0,
      ((table.sourceSize || 0) / (1024 * 1024)).toFixed(2),
      ((table.targetSize || 0) / (1024 * 1024)).toFixed(2),
      table.status || 'unknown',
      table.rateOfChange?.toFixed(2) || '',
    ]);

    // Convert to CSV string
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

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const subscriptionName = subscription?.subscriptionName || 'subscription';
    link.setAttribute('href', url);
    link.setAttribute('download', `${subscriptionName}_tables_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'text-green-600 bg-green-50';
      case 'stopped':
        return 'text-red-600 bg-red-50';
      case 'error':
        return 'text-red-600 bg-red-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  const handleToggle = async (enabled: boolean) => {
    if (!id) return;
    
    try {
      setToggling(true);
      const res = await fetch(`/api/subscriptions/${id}/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (res.ok) {
        await loadSubscriptionDetails();
      } else {
        const error = await res.json();
        alert(`Failed to ${enabled ? 'enable' : 'disable'} subscription: ${error.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      alert(`Error: ${error.message || 'Failed to toggle subscription'}`);
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    
    if (!confirm('Are you sure you want to delete this subscription? This will:\n\n- Drop the subscription on the target database\n- Remove it from the monitoring database\n\nThis action cannot be undone.')) {
      return;
    }

    const dropPublication = confirm('Also drop the publication on the source database? (Usually you want to keep it)');
    const dropSlot = confirm('Also drop the replication slot on the source database? (Usually dropped automatically)');

    try {
      setDeleting(true);
      const res = await fetch(`/api/subscriptions/${id}/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dropSubscription: true,
          dropPublication,
          dropSlot,
        }),
      });

      if (res.ok) {
        alert('Subscription deleted successfully');
        router.push('/subscriptions');
      } else {
        const error = await res.json();
        alert(`Failed to delete subscription: ${error.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      alert(`Error: ${error.message || 'Failed to delete subscription'}`);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-gray-600">Loading...</div>
        </div>
      </>
    );
  }

  if (error || !subscription) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <Link href="/subscriptions" className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
              ← Back to Subscriptions
            </Link>
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="text-red-800 font-medium">Error</div>
              <div className="text-red-600 mt-1">{error || 'Subscription not found'}</div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Link href="/subscriptions" className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
            ← Back to Subscriptions
          </Link>

        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {subscription.subscriptionName || subscription.groupName}
              </h1>
              <div className="mt-2">
                <span
                  className={`px-3 py-1 rounded text-sm font-medium ${getStatusColor(
                    subscription.status || 'stopped'
                  )}`}
                >
                  {(subscription.status || 'stopped').toUpperCase()}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right text-sm text-gray-600">
                <div>Enabled: {subscription.enabled ? 'Yes' : 'No'}</div>
                <div>Worker: {subscription.workerRunning ? 'Running' : 'Stopped'}</div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleToggle(!subscription.enabled)}
                  disabled={toggling}
                  className={`px-4 py-2 rounded-md text-sm font-medium ${
                    subscription.enabled
                      ? 'bg-yellow-600 text-white hover:bg-yellow-700'
                      : 'bg-green-600 text-white hover:bg-green-700'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {toggling ? '...' : subscription.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Replication Lag</div>
              <div className="text-2xl font-semibold">{formatBytes(subscription.lagBytes)}</div>
              {subscription.lagSeconds > 0 && (
                <div className="text-xs text-gray-500 mt-1">
                  {subscription.lagSeconds}s behind
                </div>
              )}
            </div>
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Slot Lag</div>
              <div className="text-2xl font-semibold">{formatBytes(subscription.slotLagBytes)}</div>
            </div>
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Tables</div>
              <div className="text-2xl font-semibold">{subscription.tableCount}</div>
              {subscription.tablesWithIssues > 0 && (
                <div className="text-xs text-red-600 mt-1">
                  {subscription.tablesWithIssues} with issues
                </div>
              )}
            </div>
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Conflicts</div>
              <div className={`text-2xl font-semibold ${subscription.conflicts > 0 ? 'text-red-600' : ''}`}>
                {subscription.conflicts}
              </div>
            </div>
          </div>

          {subscription.lastAppliedAt && (
            <div className="mt-4 text-sm text-gray-600">
              Last applied: {new Date(subscription.lastAppliedAt).toLocaleString()}
            </div>
          )}
        </div>

        {/* Tables Section */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Tables ({tables.length})
              </h2>
              {tables.length > 0 && (
                <div className="mt-2 flex gap-4 text-sm text-gray-600">
                  <span>
                    ✅ Safe: {tables.filter(t => t.isSafeToReplicate).length}
                  </span>
                  <span className={tables.filter(t => t.hasReplicationRisk).length > 0 ? 'text-red-600 font-semibold' : ''}>
                    ⚠️ At Risk: {tables.filter(t => t.hasReplicationRisk).length}
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              {tables.length > 0 && (
                <button
                  onClick={exportTablesToCSV}
                  className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 font-medium"
                  title="Export tables to CSV"
                >
                  📥 Export CSV
                </button>
              )}
              {loadingTables && (
                <div className="text-sm text-gray-500">Loading...</div>
              )}
            </div>
          </div>
          
          {tables.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th 
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('table')}
                    >
                      <div className="flex items-center gap-1">
                        Table {getSortIcon('table')}
                      </div>
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Source Rows
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Target Rows
                    </th>
                    <th 
                      className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('rowDiff')}
                    >
                      <div className="flex items-center justify-end gap-1">
                        Diff {getSortIcon('rowDiff')}
                      </div>
                    </th>
                    <th 
                      className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('rateOfChange')}
                    >
                      <div className="flex items-center justify-end gap-1">
                        Rate of Change {getSortIcon('rateOfChange')}
                      </div>
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Size
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Writers
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Safety
                    </th>
                    <th 
                      className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('status')}
                    >
                      <div className="flex items-center justify-center gap-1">
                        Status {getSortIcon('status')}
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {sortedTables.map((table) => (
                    <tr 
                      key={table.tableName} 
                      className={`hover:bg-gray-50 ${
                        table.hasReplicationRisk ? 'bg-red-50 border-l-4 border-red-500' : ''
                      }`}
                    >
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-900">
                        <div className="flex items-center gap-2">
                          {table.hasReplicationRisk && (
                            <span 
                              className="text-red-600 font-bold text-lg" 
                              title="⚠️ CRITICAL: Writers on both source and target - PK conflict risk!"
                            >
                              ⚠️
                            </span>
                          )}
                          {table.table}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                        {table.sourceRowCount.toLocaleString()}
                        {table.isEstimate && <span className="text-xs text-gray-400 ml-1">~</span>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                        {table.targetRowCount.toLocaleString()}
                      </td>
                      <td className={`px-4 py-3 whitespace-nowrap text-sm text-right ${
                        table.rowDiff > 0 ? 'text-red-600' : table.rowDiff < 0 ? 'text-yellow-600' : 'text-gray-600'
                      }`}>
                        {table.rowDiff !== 0 ? (table.rowDiff > 0 ? '+' : '') + table.rowDiff.toLocaleString() : '0'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right">
                        <div className="flex flex-col items-end">
                          <span className={`${
                            table.rateOfChange && table.rateOfChange > 0 
                              ? 'text-red-600 font-medium' 
                              : table.rateOfChange && table.rateOfChange < 0
                              ? 'text-green-600 font-medium'
                              : 'text-gray-600'
                          }`}>
                            {formatRateOfChange(table.rateOfChange, table.rateOfChangeInterval)}
                          </span>
                          {table.rateOfChangeInterval && (
                            <span className="text-xs text-gray-400">
                              /{table.rateOfChangeInterval}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-600">
                        {formatBytes(table.sourceSize)}
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
                          <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded font-medium" title="⚠️ Writers on both sides - PK conflict risk!">
                            ⚠️ Unsafe
                          </span>
                        ) : table.isSafeToReplicate ? (
                          <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded font-medium" title="✅ Safe to replicate - only source writers or no writers">
                            ✅ Safe
                          </span>
                        ) : (
                          <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-center">
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            table.status === 'synced'
                              ? 'bg-green-100 text-green-800'
                              : table.status === 'lagging'
                              ? 'bg-yellow-100 text-yellow-800'
                              : table.status === 'checking'
                              ? 'bg-blue-100 text-blue-800'
                              : table.status === 'warning'
                              ? 'bg-orange-100 text-orange-800'
                              : 'bg-red-100 text-red-800'
                          }`}
                          title={
                            table.status === 'checking'
                              ? 'Source count query may have failed - checking replication state'
                              : table.status === 'warning'
                              ? 'Target ahead of source - may indicate source deletions or needs investigation'
                              : undefined
                          }
                        >
                          {table.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              {loadingTables ? 'Loading tables...' : 'No tables found'}
            </div>
          )}
        </div>

        {/* Conflicts Section */}
        {subscription.conflicts > 0 && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Conflicts</h2>
            <div className="text-gray-600">
              There are {subscription.conflicts} conflict(s) detected. Check the conflicts API for details.
            </div>
            <Link
              href={`/api/conflicts?groupId=${id}`}
              className="mt-4 inline-block text-blue-600 hover:text-blue-800"
            >
              View Conflicts →
            </Link>
          </div>
        )}

        {/* Actions Section */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Actions</h2>
          <div className="space-y-2">
            <button
              onClick={() => setShowManageTables(true)}
              className="w-full px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
              Manage Tables
            </button>
            <button
              onClick={async () => {
                try {
                  const res = await fetch(`/api/conflicts/analyze?groupId=${id}`, {
                    method: 'POST',
                  });
                  if (res.ok) {
                    alert('Conflict analysis started');
                    loadSubscriptionDetails();
                  } else {
                    alert('Failed to start analysis');
                  }
                } catch (err) {
                  alert('Error: ' + err);
                }
              }}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Analyze Conflicts
            </button>
          </div>
        </div>

        {/* Replication Logs */}
        <div className="mt-6">
          <ReplicationLogs 
            subscriptionId={id as string}
            autoRefresh={true}
            refreshInterval={15000}
            maxHeight="500px"
          />
        </div>
        </div>
      </div>

      {/* Manage Tables Modal */}
      {showManageTables && subscription && (
        <ManageSubscriptionTables
          subscriptionId={id as string}
          subscriptionName={subscription.subscriptionName}
          onClose={() => setShowManageTables(false)}
          onUpdate={() => {
            loadSubscriptionDetails();
            loadTables();
          }}
        />
      )}
    </>
  );
}

