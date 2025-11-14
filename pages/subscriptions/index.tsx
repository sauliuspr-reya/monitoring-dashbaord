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
      const statusPromises = groupsData.map((group: any) =>
        fetch(`/api/groups/${group.id}/status`)
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
    if (groups.length === 0) {
      alert('No subscriptions to delete');
      return;
    }

    const count = groups.length;
    if (!confirm(`Are you sure you want to delete ALL ${count} subscription(s)?\n\nThis will:\n- Drop all subscriptions on the target database\n- Remove them from monitoring\n\nThis action cannot be undone.`)) {
      return;
    }

    try {
      setBulkToggling(true);
      
      const deletePromises = groups.map(async (group) => {
        const groupId = group.subscriptionId || '';
        try {
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
      } else {
        alert(`Successfully deleted all ${successCount} subscription(s)`);
      }

      // Close modal if open
      if (selectedModal) {
        closeModal();
      }

      // Reload the list
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
          <div className="flex justify-between items-center mb-8">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Subscriptions</h1>
              <p className="mt-2 text-gray-600">
                Manage PostgreSQL logical replication subscriptions
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => handleBulkToggle(false)}
                disabled={bulkToggling || groups.length === 0}
                className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Pause all replications (useful for backup/restore)"
              >
                {bulkToggling ? 'Pausing...' : 'Pause All'}
              </button>
              <button
                onClick={() => handleBulkToggle(true)}
                disabled={bulkToggling || groups.length === 0}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Start all replications"
              >
                {bulkToggling ? 'Starting...' : 'Start All'}
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkToggling || groups.length === 0}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Delete all subscriptions"
              >
                {bulkToggling ? 'Deleting...' : 'Delete All'}
              </button>
              <Link
                href="/subscriptions/new"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Create Subscription
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6">
            {groups.map((group) => {
              const groupId = group.subscriptionId || '';
              const isToggling = toggling.has(groupId);
              
              return (
                <div
                  key={groupId}
                  className="bg-white rounded-lg shadow p-6 hover:shadow-md transition-shadow"
                >
                  <div className="flex justify-between items-start mb-4">
                    <Link
                      href={`/subscriptions/${groupId}`}
                      className="flex-1"
                    >
                      <h3 className="text-lg font-semibold text-gray-900 hover:text-blue-600">
                        {group.subscriptionName || group.groupName}
                      </h3>
                      <div className="mt-2">
                        <span
                          className={`px-3 py-1 rounded text-sm font-medium ${getStatusColor(
                            group.status || 'stopped'
                          )}`}
                        >
                          {(group.status || 'stopped').toUpperCase()}
                        </span>
                      </div>
                    </Link>
                    <div className="flex items-center gap-3">
                      <div className="text-right text-sm text-gray-600">
                        <div>Enabled: {group.enabled ? 'Yes' : 'No'}</div>
                        <div>Worker: {group.workerRunning ? 'Running' : 'Stopped'}</div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={(e) => handleToggle(groupId, !group.enabled, e)}
                          disabled={isToggling || deleting.has(groupId)}
                          className={`px-3 py-1.5 rounded text-sm font-medium ${
                            group.enabled
                              ? 'bg-yellow-600 text-white hover:bg-yellow-700'
                              : 'bg-green-600 text-white hover:bg-green-700'
                          } disabled:opacity-50 disabled:cursor-not-allowed`}
                          title={group.enabled ? 'Disable subscription' : 'Enable subscription'}
                        >
                          {isToggling ? '...' : group.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={(e) => handleDelete(groupId, e)}
                          disabled={isToggling || deleting.has(groupId)}
                          className="px-3 py-1.5 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Delete subscription"
                        >
                          {deleting.has(groupId) ? '...' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-4">
                    <div className="bg-gray-50 p-3 rounded">
                      <div className="text-xs text-gray-500 mb-1">Status</div>
                      <div className="text-lg font-semibold">
                        <span className={`px-2 py-1 rounded text-xs ${getStatusColor(group.status || 'stopped')}`}>
                          {(group.status || 'stopped').toUpperCase()}
                        </span>
                      </div>
                    </div>
                    <div className="bg-gray-50 p-3 rounded">
                      <div className="text-xs text-gray-500 mb-1">Replication Lag</div>
                      <div className="text-lg font-semibold">{formatBytes(group.lagBytes || 0)}</div>
                      {group.lagSeconds !== undefined && group.lagSeconds > 0 && (
                        <div className="text-xs text-gray-400 mt-1">{group.lagSeconds}s</div>
                      )}
                    </div>
                    <div className="bg-gray-50 p-3 rounded">
                      <div className="text-xs text-gray-500 mb-1">Tables</div>
                      <div className="text-lg font-semibold">{group.tableCount || 0}</div>
                    </div>
                    <div className="bg-gray-50 p-3 rounded">
                      <div className="text-xs text-gray-500 mb-1">Conflicts</div>
                      <div className={`text-lg font-semibold ${(group.conflicts || 0) > 0 ? 'text-red-600' : ''}`}>
                        {group.conflicts || 0}
                      </div>
                    </div>
                    <div className="bg-gray-50 p-3 rounded">
                      <div className="text-xs text-gray-500 mb-1">Issues</div>
                      <div className={`text-lg font-semibold ${(group.tablesWithIssues || 0) > 0 ? 'text-yellow-600' : ''}`}>
                        {group.tablesWithIssues || 0}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() => openModal(groupId)}
                      className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
                    >
                      View Tables
                    </button>
                    <Link
                      href={`/subscriptions/${groupId}`}
                      className="px-3 py-1.5 bg-gray-600 text-white rounded text-sm font-medium hover:bg-gray-700"
                    >
                      View Details
                    </Link>
                  </div>
                </div>
              );
            })}

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
    </>
  );
}


