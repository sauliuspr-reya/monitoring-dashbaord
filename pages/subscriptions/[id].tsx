import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ReplicationStatus } from '@/lib/types';
import Navbar from '@/components/Navbar';
import ManageSubscriptionTables from '@/components/ManageSubscriptionTables';
import ReplicationStatusComponent from '@/components/ReplicationStatus';

// Sorting and table management now handled by ReplicationStatus component

export default function SubscriptionDetails() {
  const router = useRouter();
  const { id } = router.query;
  const [subscription, setSubscription] = useState<ReplicationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showManageTables, setShowManageTables] = useState(false);

  const loadSubscriptionDetails = useCallback(async () => {
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
  }, [id]);

  useEffect(() => {
    if (id) {
      loadSubscriptionDetails();
      // Tables and logs now refresh together in ReplicationStatus component
      const interval = setInterval(() => {
        loadSubscriptionDetails();
      }, 15000); // Refresh subscription status every 15 seconds (matches ReplicationStatus)
      return () => clearInterval(interval);
    }
  }, [id, loadSubscriptionDetails]);

  // Tables and logs now loaded by ReplicationStatus component

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

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
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
              <div className="text-2xl font-semibold">{formatBytes(subscription.lagBytes || 0)}</div>
              {subscription.lagSeconds > 0 && (
                <div className="text-xs text-gray-500 mt-1">
                  {subscription.lagSeconds}s behind
                </div>
              )}
            </div>
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Slot Lag</div>
              <div className="text-2xl font-semibold">{formatBytes(subscription.slotLagBytes || 0)}</div>
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

          {subscription.dataCopy !== undefined && (
            <div className="mt-4">
              <span className={`inline-block px-3 py-1 text-sm rounded ${
                subscription.dataCopy 
                  ? 'bg-green-100 text-green-800' 
                  : 'bg-gray-100 text-gray-800'
              }`}>
                data_copy = {subscription.dataCopy ? 'true' : 'false'}
              </span>
            </div>
          )}

          {subscription.lastAppliedAt && (
            <div className="mt-4 text-sm text-gray-600">
              Last applied: {new Date(subscription.lastAppliedAt).toLocaleString()}
            </div>
          )}
        </div>

        {/* Actions Section - Moved to Top */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
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

        {/* Tables Section - Now in unified ReplicationStatus component below */}

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

        {/* Replication Status (Unified: Logs + Rate of Change) */}
        <div className="mt-6">
          <ReplicationStatusComponent 
            subscriptionId={id as string}
            autoRefresh={true}
            refreshInterval={15000}
            defaultTimeRange="1h"
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
            // Tables will refresh automatically via ReplicationStatus component
          }}
        />
      )}
    </>
  );
}

