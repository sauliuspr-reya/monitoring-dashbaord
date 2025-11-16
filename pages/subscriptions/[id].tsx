import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ReplicationStatus } from '@/lib/types';
import Navbar from '@/components/Navbar';
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

        {/* Subscription Header - Clean and Simple */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-3">
                <h1 className="text-2xl font-bold text-gray-900">
                  {subscription.subscriptionName || subscription.groupName}
                </h1>
                <span
                  className={`px-3 py-1 rounded text-sm font-medium ${getStatusColor(
                    subscription.status || 'stopped'
                  )}`}
                >
                  {(subscription.status || 'stopped').toUpperCase()}
                </span>
              </div>
              
              {/* Key Metrics - Compact */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-4">
                <div>
                  <div className="text-xs text-gray-500">Replication Lag</div>
                  <div className="text-lg font-semibold">{formatBytes(subscription.lagBytes || 0)}</div>
                  {subscription.lagSeconds > 0 && (
                    <div className="text-xs text-gray-400">{subscription.lagSeconds}s</div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-gray-500">Slot Lag</div>
                  <div className="text-lg font-semibold">{formatBytes(subscription.slotLagBytes || 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Tables</div>
                  <div className="text-lg font-semibold">{subscription.tableCount}</div>
                  {subscription.tablesWithIssues > 0 && (
                    <div className="text-xs text-red-600">{subscription.tablesWithIssues} issues</div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-gray-500">Conflicts</div>
                  <div className={`text-lg font-semibold ${subscription.conflicts > 0 ? 'text-red-600' : ''}`}>
                    {subscription.conflicts}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Status</div>
                  <div className="text-sm">
                    <span className={subscription.enabled ? 'text-green-600' : 'text-gray-400'}>
                      {subscription.enabled ? '✓ Enabled' : '✗ Disabled'}
                    </span>
                    <br />
                    <span className={subscription.workerRunning ? 'text-green-600' : 'text-gray-400'}>
                      {subscription.workerRunning ? '✓ Running' : '✗ Stopped'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Metadata */}
              <div className="flex items-center gap-4 mt-4 text-xs text-gray-500">
                {subscription.lastAppliedAt && (
                  <span>Last applied: {new Date(subscription.lastAppliedAt).toLocaleString()}</span>
                )}
                {subscription.dataCopy !== undefined && (
                  <span className="px-2 py-1 bg-gray-100 rounded">
                    data_copy = {subscription.dataCopy ? 'true' : 'false'}
                  </span>
                )}
              </div>
            </div>

            {/* Action Buttons - Only Essential */}
            <div className="flex gap-2 ml-4">
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

        {/* Conflicts Alert - Only show if conflicts exist */}
        {subscription.conflicts > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-red-800 font-medium">⚠️ {subscription.conflicts} Conflict(s) Detected</div>
                <div className="text-red-600 text-sm mt-1">
                  Data conflicts detected in replication. Check the Logs tab for details.
                </div>
              </div>
              <Link
                href={`/api/conflicts?groupId=${id}`}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm font-medium"
              >
                View Details
              </Link>
            </div>
          </div>
        )}

        {/* Replication Status (Unified: Overview, Tables, Logs) */}
        <div className="mt-6">
          <ReplicationStatusComponent 
            subscriptionId={id as string}
            autoRefresh={true}
            refreshInterval={300000}
            defaultTimeRange="1h"
          />
        </div>
        </div>
      </div>
    </>
  );
}

