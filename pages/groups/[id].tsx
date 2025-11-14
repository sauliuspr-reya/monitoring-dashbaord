import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ReplicationStatus } from '@/lib/types';

export default function GroupDetails() {
  const router = useRouter();
  const { id } = router.query;
  const [group, setGroup] = useState<ReplicationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGroupDetails = useCallback(async () => {
    if (!id) return;
    
    try {
      const res = await fetch(`/api/groups/${id}/status`);
      if (!res.ok) {
        throw new Error(`Failed to load group: ${res.statusText}`);
      }
      const data = await res.json();
      setGroup(data);
      setLoading(false);
      setError(null);
    } catch (err: any) {
      console.error('Error loading group details:', err);
      setError(err.message);
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) {
      loadGroupDetails();
      const interval = setInterval(loadGroupDetails, 5000);
      return () => clearInterval(interval);
    }
  }, [id, loadGroupDetails]);

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

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  if (error || !group) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Link href="/" className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
            ← Back to Dashboard
          </Link>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="text-red-800 font-medium">Error</div>
            <div className="text-red-600 mt-1">{error || 'Group not found'}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/" className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
          ← Back to Dashboard
        </Link>

        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{group.groupName}</h1>
              <div className="mt-2">
                <span
                  className={`px-3 py-1 rounded text-sm font-medium ${getStatusColor(
                    group.status
                  )}`}
                >
                  {group.status.toUpperCase()}
                </span>
              </div>
            </div>
            <div className="text-right text-sm text-gray-600">
              <div>Enabled: {group.enabled ? 'Yes' : 'No'}</div>
              <div>Worker: {group.workerRunning ? 'Running' : 'Stopped'}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Replication Lag</div>
              <div className="text-2xl font-semibold">{formatBytes(group.lagBytes)}</div>
              {group.lagSeconds > 0 && (
                <div className="text-xs text-gray-500 mt-1">
                  {group.lagSeconds}s behind
                </div>
              )}
            </div>
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Slot Lag</div>
              <div className="text-2xl font-semibold">{formatBytes(group.slotLagBytes)}</div>
            </div>
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Tables</div>
              <div className="text-2xl font-semibold">{group.tableCount}</div>
              {group.tablesWithIssues > 0 && (
                <div className="text-xs text-red-600 mt-1">
                  {group.tablesWithIssues} with issues
                </div>
              )}
            </div>
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-xs text-gray-500 mb-1">Conflicts</div>
              <div className={`text-2xl font-semibold ${group.conflicts > 0 ? 'text-red-600' : ''}`}>
                {group.conflicts}
              </div>
            </div>
          </div>

          {group.lastAppliedAt && (
            <div className="mt-4 text-sm text-gray-600">
              Last applied: {new Date(group.lastAppliedAt).toLocaleString()}
            </div>
          )}
        </div>

        {/* Conflicts Section */}
        {group.conflicts > 0 && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Conflicts</h2>
            <div className="text-gray-600">
              There are {group.conflicts} conflict(s) detected. Check the conflicts API for details.
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
              onClick={async () => {
                try {
                  const res = await fetch(`/api/conflicts/analyze?groupId=${id}`, {
                    method: 'POST',
                  });
                  if (res.ok) {
                    alert('Conflict analysis started');
                    loadGroupDetails();
                  } else {
                    alert('Failed to start analysis');
                  }
                } catch (err) {
                  alert('Error: ' + err);
                }
              }}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Analyze Conflicts
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

