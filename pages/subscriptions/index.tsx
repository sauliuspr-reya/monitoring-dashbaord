import { useState, useEffect } from 'react';
import { ReplicationStatus } from '@/lib/types';
import Link from 'next/link';
import Navbar from '@/components/Navbar';

export default function SubscriptionsPage() {
  const [groups, setGroups] = useState<ReplicationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [bulkToggling, setBulkToggling] = useState(false);
  const [selectedModal, setSelectedModal] = useState<string | null>(null);
  const [modalTables, setModalTables] = useState<any[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [bulkDeleteOptions, setBulkDeleteOptions] = useState({
    dropSubscription: true,
    dropPublication: false,
    dropSlot: false,
  });

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const groupsRes = await fetch('/api/groups');
      if (!groupsRes.ok) {
        throw new Error(`Failed to load subscriptions: ${groupsRes.statusText}`);
      }
      const groupsData = await groupsRes.json();

      if (!groupsData || groupsData.length === 0) {
        setGroups([]);
        setLoading(false);
        return;
      }

      // Fetch status for all subscriptions in parallel
      // Skip expensive table queries by default - only load when viewing details
      const statusPromises = groupsData.map((group: any) =>
        fetch(`/api/groups/${group.id}/status?includeTables=false`)
          .then((res) => {
            if (!res.ok) {
              console.warn(`Failed to load status for subscription ${group.id}: ${res.statusText}`);
              // Return a minimal status object if the status endpoint fails
              return {
                subscriptionId: group.id,
                subscriptionName: group.name,
                groupId: group.id,
                groupName: group.name,
                enabled: group.enabled,
                status: 'error',
                subscriptionEnabled: false,
                workerRunning: false,
                lagBytes: 0,
                lagSeconds: 0,
                slotLagBytes: 0,
                tableCount: 0,
                tablesWithIssues: 0,
                conflicts: 0,
              } as ReplicationStatus;
            }
            return res.json();
          })
          .catch((error) => {
            console.error(`Error loading status for subscription ${group.id}:`, error);
            // Return a minimal status object on error
            return {
              subscriptionId: group.id,
              subscriptionName: group.name,
              groupId: group.id,
              groupName: group.name,
              enabled: group.enabled,
              status: 'error',
              subscriptionEnabled: false,
              workerRunning: false,
              lagBytes: 0,
              lagSeconds: 0,
              slotLagBytes: 0,
              tableCount: 0,
              tablesWithIssues: 0,
              conflicts: 0,
            } as ReplicationStatus;
          })
      );
      const statuses = await Promise.all(statusPromises);
      const filteredStatuses = statuses.filter((s): s is ReplicationStatus => s !== null);
      setGroups(filteredStatuses);
      setLoading(false);
    } catch (error) {
      console.error('Error loading data:', error);
      setGroups([]);
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

  // Filter groups by search
  const filteredGroups = groups.filter(g => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (g.subscriptionName || '').toLowerCase().includes(q) ||
      (g.groupName || '').toLowerCase().includes(q)
    );
  });

  // Summary stats
  const summary = {
    total: groups.length,
    active: groups.filter(g => g.status === 'active').length,
    stopped: groups.filter(g => g.status === 'stopped' || !g.enabled).length,
    errors: groups.filter(g => g.status === 'error' || (g.conflicts || 0) > 0).length,
    totalLag: groups.reduce((sum, g) => sum + (g.lagBytes || 0), 0),
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredGroups.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredGroups.map(g => g.subscriptionId || '')));
    }
  };

  const handleDelete = async (groupId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!confirm('Are you sure you want to delete this subscription?\n\nThis will drop the subscription on the target database and remove it from monitoring.\n\nThis action cannot be undone.')) {
      return;
    }

    try {
      setDeleting(prev => new Set(prev).add(groupId));
      const res = await fetch(`/api/subscriptions/${groupId}/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dropSubscription: true,
          dropPublication: false,
          dropSlot: false,
        }),
      });

      if (res.ok) {
        // Close modal if it's open for this subscription
        if (selectedModal === groupId) {
          closeModal();
        }
        // Reload the list
        await loadData();
      } else {
        const error = await res.json();
        alert(`Failed to delete subscription: ${error.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      alert(`Error: ${error.message || 'Failed to delete subscription'}`);
    } finally {
      setDeleting(prev => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) {
      alert('No subscriptions selected');
      return;
    }

    setShowBulkDeleteModal(false);
    setBulkToggling(true);
    
    try {
      const idsToDelete = Array.from(selectedIds);
      const deletePromises = idsToDelete.map(async (groupId) => {
        try {
          const res = await fetch(`/api/subscriptions/${groupId}/delete`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bulkDeleteOptions),
          });
          
          if (res.ok) {
            return { id: groupId, success: true };
          } else {
            const error = await res.json();
            return { id: groupId, success: false, error: error.error };
          }
        } catch (error: any) {
          return { id: groupId, success: false, error: error.message };
        }
      });

      const results = await Promise.all(deletePromises);
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      if (failCount > 0) {
        const errors = results.filter(r => !r.success).map(r => `- ${r.id}: ${r.error}`).join('\n');
        alert(`Deleted ${successCount} subscription(s).\n\nFailed to delete ${failCount}:\n${errors}`);
      }

      // Close modal if open
      if (selectedModal) {
        closeModal();
      }

      setSelectedIds(new Set());
      await loadData();
    } catch (error: any) {
      alert(`Error: ${error.message || 'Failed to delete subscriptions'}`);
    } finally {
      setBulkToggling(false);
    }
  };

  const handleToggle = async (groupId: string, enabled: boolean, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent navigation
    
    try {
      setToggling(prev => new Set(prev).add(groupId));
      const res = await fetch(`/api/subscriptions/${groupId}/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (res.ok) {
        await loadData();
      } else {
        const error = await res.json();
        alert(`Failed to ${enabled ? 'enable' : 'disable'} subscription: ${error.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      alert(`Error: ${error.message || 'Failed to toggle subscription'}`);
    } finally {
      setToggling(prev => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
    }
  };

  const handleBulkToggle = async (enabled: boolean) => {
    if (!confirm(`Are you sure you want to ${enabled ? 'start' : 'pause'} all replications?`)) {
      return;
    }

    try {
      setBulkToggling(true);
      const res = await fetch('/api/subscriptions/bulk-enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (res.ok) {
        const data = await res.json();
        alert(`${data.message}${data.errors.length > 0 ? `\n\nErrors: ${data.errors.length}` : ''}`);
        await loadData();
      } else {
        const error = await res.json();
        alert(`Failed to ${enabled ? 'start' : 'pause'} all replications: ${error.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      alert(`Error: ${error.message || 'Failed to bulk toggle subscriptions'}`);
    } finally {
      setBulkToggling(false);
    }
  };

  const openModal = async (groupId: string) => {
    console.log('Opening modal for:', groupId);
    console.log('Current groups:', groups.length);
    
    // Check if subscription still exists before opening modal
    const group = groups.find(g => g.subscriptionId === groupId);
    if (!group) {
      console.log('Subscription not found in groups list');
      alert('Subscription not found. It may have been deleted. Refreshing page...');
      await loadData();
      return;
    }

    console.log('Found subscription:', group.subscriptionName);
    setSelectedModal(groupId);
    setLoadingTables(true);
    setTableError(null);
    setModalTables([]);
    
    try {
      const res = await fetch(`/api/subscriptions/${groupId}/tables`);
      
      if (!res.ok) {
        console.log('[openModal] API error:', res.status, res.statusText);
        // API returned an error status - try to parse error message
        let errorMsg = `Failed to load tables: ${res.statusText}`;
        try {
          const errorData = await res.json();
          errorMsg = errorData.error || errorMsg;
          console.log('[openModal] Error message:', errorMsg);
        } catch {
          // If JSON parsing fails, use the status text
        }
        
        setTableError(errorMsg);
        setModalTables([]);
        
        // If subscription not found, close modal and refresh data
        if (res.status === 404) {
          console.log('[openModal] 404 - subscription not found, closing modal and refreshing');
          setTimeout(() => {
            closeModal();
            loadData();
          }, 2000);
        }
        return;
      }
      
      // Parse JSON only if response is ok
      const data = await res.json();

      // API returned success
      const tables = data.tables || [];
      
      // Double-check if subscription still exists in our current list
      const currentGroup = groups.find(g => g.subscriptionId === groupId);
      if (!currentGroup) {
        // Subscription was deleted while modal was opening
        setTableError('Subscription not found. It may have been deleted.');
        setTimeout(() => {
          closeModal();
          loadData();
        }, 2000);
        return;
      }

      // Set tables regardless of count
      setModalTables(tables);
      
      // Log for debugging
      console.log(`[Modal] Loaded ${tables.length} tables for subscription ${groupId}`);
    } catch (error: any) {
      console.error('Error loading tables:', error);
      setTableError(error.message || 'Failed to load tables. The subscription may have been deleted.');
      setModalTables([]);
    } finally {
      setLoadingTables(false);
    }
  };

  const closeModal = () => {
    setSelectedModal(null);
    setModalTables([]);
    setTableError(null);
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

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-6 flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Subscriptions</h1>
              <p className="mt-1 text-gray-600">Manage PostgreSQL logical replication subscriptions</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleBulkToggle(false)}
                disabled={bulkToggling || groups.length === 0}
                className="px-4 py-2 bg-orange-600 text-white rounded-md hover:bg-orange-700 disabled:opacity-50"
              >
                Pause All
              </button>
              <button
                onClick={() => handleBulkToggle(true)}
                disabled={bulkToggling || groups.length === 0}
                className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              >
                Start All
              </button>
              <Link
                href="/subscriptions/new"
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                + New Subscription
              </Link>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="mb-6 grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-2xl font-bold text-gray-900">{summary.total}</div>
              <div className="text-sm text-gray-500">Total</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-2xl font-bold text-green-600">{summary.active}</div>
              <div className="text-sm text-gray-500">Active</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-2xl font-bold text-yellow-600">{summary.stopped}</div>
              <div className="text-sm text-gray-500">Stopped</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-2xl font-bold text-red-600">{summary.errors}</div>
              <div className="text-sm text-gray-500">Errors</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-2xl font-bold text-blue-600">{formatBytes(summary.totalLag)}</div>
              <div className="text-sm text-gray-500">Total Lag</div>
            </div>
          </div>

          {/* Controls */}
          <div className="mb-6 bg-white rounded-lg shadow p-4 flex flex-wrap gap-4 items-center justify-between">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedIds.size > 0 && selectedIds.size === filteredGroups.length}
                  onChange={toggleSelectAll}
                  className="rounded"
                />
                Select All
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search subscriptions..."
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md w-64"
              />
              <button onClick={loadData} className="px-3 py-1.5 text-sm bg-gray-100 rounded-md hover:bg-gray-200">
                ↻ Refresh
              </button>
            </div>
          </div>

          {/* Bulk Actions Bar */}
          {selectedIds.size > 0 && (
            <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-blue-800">{selectedIds.size} subscription(s) selected</span>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Clear
                </button>
              </div>
              <button
                onClick={() => setShowBulkDeleteModal(true)}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700"
              >
                Delete Selected
              </button>
            </div>
          )}

          <div className="space-y-4">
            {filteredGroups.map((group) => {
              const groupId = group.subscriptionId || '';
              const isToggling = toggling.has(groupId);
              const borderColor = group.status === 'active' ? 'border-green-500' : 
                                  group.status === 'error' || (group.conflicts || 0) > 0 ? 'border-red-500' : 
                                  'border-yellow-500';
              
              return (
                <div
                  key={groupId}
                  className={`bg-white rounded-lg shadow border-l-4 ${borderColor} overflow-hidden ${selectedIds.has(groupId) ? 'ring-2 ring-blue-500' : ''}`}
                >
                  {/* Header */}
                  <div className="p-4 border-b border-gray-100">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(groupId)}
                          onChange={() => toggleSelect(groupId)}
                          className="rounded w-4 h-4"
                        />
                        <span className="text-xl">{group.status === 'active' ? '🔄' : group.status === 'error' ? '❌' : '⏸️'}</span>
                        <div>
                          <Link href={`/subscriptions/${groupId}`}>
                            <h3 className="font-semibold text-gray-900 hover:text-blue-600">
                              {group.subscriptionName || group.groupName}
                            </h3>
                          </Link>
                          <div className="text-xs text-gray-500">
                            {group.tableCount || 0} tables • {formatBytes(group.lagBytes || 0)} lag
                          </div>
                        </div>
                      </div>
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(group.status || 'stopped')}`}>
                        {(group.status || 'stopped').toUpperCase()}
                      </span>
                    </div>
                  </div>

                  {/* Stats Grid */}
                  <div className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4">
                    <div className="space-y-1">
                      <div className="text-xs font-semibold text-gray-500 uppercase">Enabled</div>
                      <div className={`text-sm font-medium ${group.enabled ? 'text-green-600' : 'text-gray-500'}`}>
                        {group.enabled ? '● Yes' : '○ No'}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-semibold text-gray-500 uppercase">Worker</div>
                      <div className={`text-sm font-medium ${group.workerRunning ? 'text-green-600' : 'text-gray-500'}`}>
                        {group.workerRunning ? '● Running' : '○ Stopped'}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-semibold text-gray-500 uppercase">Lag</div>
                      <div className="text-sm font-medium">{formatBytes(group.lagBytes || 0)}</div>
                      {group.lagSeconds !== undefined && group.lagSeconds > 0 && (
                        <div className="text-xs text-gray-400">{group.lagSeconds}s</div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-semibold text-gray-500 uppercase">Conflicts</div>
                      <div className={`text-sm font-medium ${(group.conflicts || 0) > 0 ? 'text-red-600' : ''}`}>
                        {group.conflicts || 0}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-semibold text-gray-500 uppercase">Issues</div>
                      <div className={`text-sm font-medium ${(group.tablesWithIssues || 0) > 0 ? 'text-yellow-600' : ''}`}>
                        {group.tablesWithIssues || 0}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex gap-2">
                    <button
                      onClick={() => openModal(groupId)}
                      className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-100"
                    >
                      View Tables
                    </button>
                    <Link
                      href={`/subscriptions/${groupId}`}
                      className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-100"
                    >
                      View Details
                    </Link>
                    <button
                      onClick={(e) => handleToggle(groupId, !group.enabled, e)}
                      disabled={isToggling || deleting.has(groupId)}
                      className={`px-3 py-1.5 text-sm rounded font-medium ${
                        group.enabled
                          ? 'text-yellow-600 border border-yellow-300 hover:bg-yellow-50'
                          : 'text-green-600 border border-green-300 hover:bg-green-50'
                      } disabled:opacity-50`}
                    >
                      {isToggling ? '...' : group.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={(e) => handleDelete(groupId, e)}
                      disabled={isToggling || deleting.has(groupId)}
                      className="px-3 py-1.5 text-sm text-red-600 border border-red-300 rounded hover:bg-red-50 disabled:opacity-50 ml-auto"
                    >
                      {deleting.has(groupId) ? '...' : 'Delete'}
                    </button>
                  </div>
                </div>
              );
            })}

            {filteredGroups.length === 0 && groups.length > 0 && (
              <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
                No subscriptions match your search
              </div>
            )}

            {groups.length === 0 && (
              <div className="bg-white rounded-lg shadow p-12 text-center">
                <p className="text-gray-500 mb-4">No subscriptions found</p>
                <Link
                  href="/subscriptions/new"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 inline-block"
                >
                  Create Your First Subscription
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal for Tables View */}
      {selectedModal && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={closeModal}
        >
          <div 
            className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-6 border-b">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">
                  {groups.find(g => g.subscriptionId === selectedModal)?.subscriptionName || 'Tables'}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  Replication settings and table status
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={async () => {
                    const group = groups.find(g => g.subscriptionId === selectedModal);
                    if (group) {
                      const fakeEvent = { stopPropagation: () => {} } as React.MouseEvent;
                      await handleToggle(selectedModal, !group.enabled, fakeEvent);
                      // Refresh tables after toggling
                      if (selectedModal) {
                        await openModal(selectedModal);
                      }
                    }
                  }}
                  disabled={toggling.has(selectedModal)}
                  className={`px-4 py-2 rounded-md text-sm font-medium ${
                    groups.find(g => g.subscriptionId === selectedModal)?.enabled
                      ? 'bg-yellow-600 text-white hover:bg-yellow-700'
                      : 'bg-green-600 text-white hover:bg-green-700'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {toggling.has(selectedModal) ? '...' : groups.find(g => g.subscriptionId === selectedModal)?.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={closeModal}
                  className="px-4 py-2 bg-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-400"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6">
              {loadingTables ? (
                <div className="text-center py-8 text-gray-500">Loading tables...</div>
              ) : tableError ? (
                <div className="text-center py-8">
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4 max-w-md mx-auto">
                    <div className="text-red-800 font-medium mb-1">Error Loading Tables</div>
                    <div className="text-red-600 text-sm">{tableError}</div>
                    <button
                      onClick={closeModal}
                      className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : modalTables.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Table
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Source Rows
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Target Rows
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Diff
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Writers
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Risk
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Safety
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Replication
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {modalTables.map((table: any) => (
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
                              {table.table || table.tableName}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                            {table.sourceRowCount?.toLocaleString() || '0'}
                            {table.isEstimate && <span className="text-xs text-gray-400 ml-1">~</span>}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                            {table.targetRowCount?.toLocaleString() || '0'}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap text-sm text-right ${
                            table.rowDiff > 0 ? 'text-red-600' : table.rowDiff < 0 ? 'text-yellow-600' : 'text-gray-600'
                          }`}>
                            {table.rowDiff !== 0 ? (table.rowDiff > 0 ? '+' : '') + table.rowDiff.toLocaleString() : '0'}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                            {table.writersOnSource && table.writersOnSource.length > 0 && (
                              <span className="px-1.5 py-0.5 bg-orange-100 text-orange-800 text-xs rounded font-medium mr-1">
                                S:{table.writersOnSource.length}
                              </span>
                            )}
                            {table.writersOnTarget && table.writersOnTarget.length > 0 && (
                              <span className="px-1.5 py-0.5 bg-blue-100 text-blue-800 text-xs rounded font-medium">
                                T:{table.writersOnTarget.length}
                              </span>
                            )}
                            {(!table.writersOnSource || table.writersOnSource.length === 0) &&
                             (!table.writersOnTarget || table.writersOnTarget.length === 0) && (
                              <span className="text-gray-400 text-xs">None</span>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-center">
                            {table.hasReplicationRisk ? (
                              <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded font-medium" title="⚠️ Writers on both sides - PK conflict risk!">
                                Yes
                              </span>
                            ) : (
                              <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                                No
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-center">
                            {table.hasReplicationRisk ? (
                              <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded font-medium" title="⚠️ Writers on both sides - PK conflict risk!">
                                Unsafe
                              </span>
                            ) : table.isSafeToReplicate ? (
                              <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded font-medium" title="✅ Safe to replicate - only source writers or no writers">
                                Safe
                              </span>
                            ) : (
                              <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                                None
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
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {table.status || 'unknown'}
                            </span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-600">
                            {table.rateOfChange !== null && table.rateOfChange !== undefined ? (
                              <span className={`${
                                table.rateOfChange > 0 
                                  ? 'text-red-600 font-medium' 
                                  : table.rateOfChange < 0
                                  ? 'text-green-600 font-medium'
                                  : 'text-gray-600'
                              }`}>
                                {table.rateOfChange > 0 ? '+' : ''}{table.rateOfChange > 0 ? Math.round(table.rateOfChange) : table.rateOfChange.toFixed(1)}
                                {table.rateOfChangeInterval && (
                                  <span className="text-xs text-gray-400 ml-1">
                                    /{table.rateOfChangeInterval}
                                  </span>
                                )}
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
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <p className="mb-2">No tables found in this subscription.</p>
                  <p className="text-sm text-gray-400">The publication may be empty.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Modal */}
      {showBulkDeleteModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Delete {selectedIds.size} Subscription(s)</h3>
            <p className="text-sm text-gray-600 mb-4">
              Select what to delete along with the subscription(s):
            </p>
            
            <div className="space-y-3 mb-6">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bulkDeleteOptions.dropSubscription}
                  onChange={e => setBulkDeleteOptions(o => ({ ...o, dropSubscription: e.target.checked }))}
                  className="rounded"
                  disabled
                />
                <span className="text-sm">Drop Subscription (required)</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bulkDeleteOptions.dropSlot}
                  onChange={e => setBulkDeleteOptions(o => ({ ...o, dropSlot: e.target.checked }))}
                  className="rounded"
                />
                <span className="text-sm">Drop Replication Slot on source</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bulkDeleteOptions.dropPublication}
                  onChange={e => setBulkDeleteOptions(o => ({ ...o, dropPublication: e.target.checked }))}
                  className="rounded"
                />
                <span className="text-sm">Drop Publication on source</span>
              </label>
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowBulkDeleteModal(false)}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkToggling}
                className="px-4 py-2 text-sm text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50"
              >
                {bulkToggling ? 'Deleting...' : `Delete ${selectedIds.size} Subscription(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


