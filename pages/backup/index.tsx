import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Navbar from '@/components/Navbar';
import BackupJobList from '@/components/BackupJobList';
import BackupModal from '@/components/BackupModal';
import RestoreModal from '@/components/RestoreModal';

interface TableInfo {
  tableName: string; // Full name: schema.table
  schema: string;
  table: string; // Just the table name
  sourceRowCount: number;
  sourceSize: number;
  services?: string[];
  writersOnSource?: string[];
  writersOnTarget?: string[];
  rateOfChange1Hour?: number | null;
  rateOfChange24Hour?: number | null;
  loading?: boolean;
}

interface BackupInfo {
  filename: string;
  filepath: string;
  size: number;
  created: string;
  modified: string;
}

interface BackupTaskInfo {
  id: string;
  task_type: 'backup' | 'restore';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stalled';
  filename?: string;
  filepath?: string;
  file_size?: number;
  tables?: string[];
  exclude_tables?: string[];
  snapshot_id?: string;
  slot_name?: string;
  publication_name?: string;
  slot_initial_lsn?: string;
  schema_only?: boolean;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

export default function BackupPage() {
  const router = useRouter();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupTasks, setBackupTasks] = useState<BackupTaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingBackups, setLoadingBackups] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState<{ [key: string]: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Modal states
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  
  // Monitor tab state (collapsible)
  const [showMonitor, setShowMonitor] = useState(false);


  useEffect(() => {
    loadTables();
    loadBackups();
    loadBackupTasks();
  }, []);

  useEffect(() => {
    // Refresh tasks every 5 seconds if there are running tasks
    const interval = setInterval(() => {
      const hasRunningTasks = backupTasks.some(t => t.status === 'running' || t.status === 'pending');
      if (hasRunningTasks) {
        loadBackupTasks();
      }
    }, 5000);

    // Check for stalled tasks every 2 minutes
    const stalledCheckInterval = setInterval(() => {
      const hasRunningTasks = backupTasks.some(t => t.status === 'running');
      if (hasRunningTasks) {
        fetch('/api/backup/check-stalled', { method: 'POST' })
          .then(() => loadBackupTasks())
          .catch(err => console.error('Error checking for stalled tasks:', err));
      }
    }, 2 * 60 * 1000); // Every 2 minutes

    return () => {
      clearInterval(interval);
      clearInterval(stalledCheckInterval);
    };
  }, [backupTasks]);
  

  const loadTables = async () => {
    try {
      const res = await fetch('/api/tables/all');
      if (res.ok) {
        const data = await res.json();
        setTables(data.tables || []);
      }
    } catch (err: any) {
      console.error('Error loading tables:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadBackups = async () => {
    try {
      setLoadingBackups(true);
      const res = await fetch('/api/backup/list');
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch (err: any) {
      console.error('Error loading backups:', err);
    } finally {
      setLoadingBackups(false);
    }
  };

  const loadBackupTasks = async () => {
    try {
      setLoadingTasks(true);
      // Load both backup and restore tasks (remove task_type filter to get all)
      const res = await fetch('/api/backup/tasks?limit=100');
      if (res.ok) {
        const data = await res.json();
        setBackupTasks(data.tasks || []);
      }
    } catch (err: any) {
      console.error('Error loading tasks:', err);
    } finally {
      setLoadingTasks(false);
    }
  };

  const handleCancelTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to cancel this backup task?')) {
      return;
    }

    try {
      const res = await fetch(`/api/backup/tasks/${taskId}`, {
        method: 'POST',
      });
      if (res.ok) {
        setSuccess('Backup task cancelled successfully');
        loadBackupTasks();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cancel task');
      }
    } catch (err: any) {
      setError('Failed to cancel task: ' + err.message);
    }
  };

  const handleDeleteTask = async (taskId: string, hasFile: boolean) => {
    const message = hasFile
      ? 'Are you sure you want to delete this task? This will also delete the backup file.'
      : 'Are you sure you want to delete this task?';
    if (!confirm(message)) {
      return;
    }

    try {
      const res = await fetch(`/api/backup/tasks/${taskId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deleteFile: hasFile }),
      });
      if (res.ok) {
        setSuccess('Backup task deleted successfully');
        loadBackupTasks();
        loadBackups(); // Refresh backup list in case file was deleted
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete task');
      }
    } catch (err: any) {
      setError('Failed to delete task: ' + err.message);
    }
  };

  const handleCreateSubscriptionFromBackup = async (backupTaskId: string, subscriptionName: string) => {
    if (!subscriptionName || !subscriptionName.trim()) {
      setError('Subscription name is required');
      return;
    }

    try {
      setError(null);
      setSuccess(null);

      const res = await fetch('/api/subscriptions/create-from-backup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          backupTaskId,
          subscriptionName: subscriptionName.trim(),
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(`Subscription "${subscriptionName}" created successfully using slot from backup task`);
        // Optionally redirect to subscription page
        setTimeout(() => {
          router.push(`/subscriptions`);
        }, 2000);
      } else {
        setError(data.error || data.details || 'Failed to create subscription');
      }
    } catch (err: any) {
      setError('Failed to create subscription: ' + err.message);
    }
  };


  const handleBackup = async (options: {
    tables?: string[];
    excludeTables?: string[];
    schemaOnly: boolean;
    enableReplication: boolean;
  }) => {
    try {
      setBackingUp(true);
      setError(null);
      setSuccess(null);

      const requestBody: any = {
        schemaOnly: options.schemaOnly,
        enableReplication: options.enableReplication,
      };

      if (options.excludeTables && options.excludeTables.length > 0) {
        requestBody.excludeTables = options.excludeTables;
      } else if (options.tables && options.tables.length > 0) {
        requestBody.tables = options.tables;
      }

      const res = await fetch('/api/backup/create-with-slot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const data = await res.json();

      if (res.ok) {
        loadBackupTasks();
        setShowBackupModal(false);
        setSuccess(`Backup task created successfully${options.enableReplication ? ' with replication slot' : ''}`);
      } else {
        setError(data.error || 'Failed to create backup task');
      }
    } catch (err: any) {
      setError('Failed to create backup: ' + err.message);
    } finally {
      setBackingUp(false);
    }
  };


  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const handleRestoreFromModal = async (filename: string) => {
    try {
      setRestoring(prev => ({ ...prev, [filename]: true }));
      setError(null);
      setSuccess(null);

      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename,
          dryRun: false,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        if (data.taskId) {
          setSuccess(`Restore task created (ID: ${data.taskId.substring(0, 8)}...). Restore in progress...`);
          setShowRestoreModal(false);
        }
        loadBackupTasks();
      } else {
        setError(data.error || 'Failed to restore backup');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to restore backup');
    } finally {
      setRestoring(prev => ({ ...prev, [filename]: false }));
    }
  };

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-6 sm:px-8 lg:px-12 py-8">
          <div className="mb-8">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">Backup & Restore</h1>
                <p className="mt-2 text-gray-600">
                  Manage backup and restore operations for your database
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowBackupModal(true)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
                >
                  + Create Backup
                </button>
                <button
                  onClick={() => setShowRestoreModal(true)}
                  className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium"
                >
                  ↻ Restore
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="text-red-800 font-medium">Error</div>
              <div className="text-red-600 mt-1">{error}</div>
            </div>
          )}

          {success && (
            <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="text-green-800 font-medium">Success</div>
              <div className="text-green-600 mt-1">{success}</div>
            </div>
          )}

          {/* Monitor Section (Collapsible) */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <button
              onClick={() => setShowMonitor(!showMonitor)}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center">
                <h2 className="text-xl font-semibold text-gray-900">Monitor</h2>
                <span className="ml-3 text-sm text-gray-500">Backup status and replication gaps</span>
              </div>
              <span className="text-gray-400">{showMonitor ? '▼' : '▶'}</span>
            </button>
            {showMonitor && (
              <div className="px-6 py-4 border-t border-gray-200">
                <MonitorTab />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      <BackupModal
        isOpen={showBackupModal}
        onClose={() => setShowBackupModal(false)}
        tables={tables}
        loading={loading}
        onBackup={handleBackup}
        backingUp={backingUp}
      />

      <RestoreModal
        isOpen={showRestoreModal}
        onClose={() => setShowRestoreModal(false)}
        backups={backups}
        loading={loadingBackups}
        onRestore={handleRestoreFromModal}
        restoring={restoring}
        formatBytes={formatBytes}
      />
    </>
  );
}

// Monitor Tab Component
function MonitorTab() {
  const [backupStatus, setBackupStatus] = useState<any>(null);
  const [gapAnalysis, setGapAnalysis] = useState<any>(null);
  const [copyProgress, setCopyProgress] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const [backupRes, gapRes, copyRes] = await Promise.all([
        fetch('/api/backups/status'),
        fetch('/api/replication/gap-analysis'),
        fetch('/api/replication/copy-progress')
      ]);

      if (backupRes.ok) {
        const backupData = await backupRes.json();
        setBackupStatus(backupData);
      }

      if (gapRes.ok) {
        const gapData = await gapRes.json();
        setGapAnalysis(gapData);
      }

      if (copyRes.ok) {
        const copyData = await copyRes.json();
        setCopyProgress(copyData);
      }

      setLoading(false);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const formatTimestamp = (date: Date | string): string => {
    const d = new Date(date);
    return d.toLocaleString();
  };

  const getTimeAgo = (date: Date | string): string => {
    const now = new Date();
    const then = new Date(date);
    const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-gray-500">Loading monitor data...</div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">Error: {error}</p>
        </div>
      )}

      {/* Backup Status Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm text-gray-600">Last Backup</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">
            {backupStatus?.lastBackup ? getTimeAgo(backupStatus.lastBackup.timestamp) : 'N/A'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {backupStatus?.lastBackup ? formatTimestamp(backupStatus.lastBackup.timestamp) : ''}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm text-gray-600">Total Backups</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">
            {backupStatus?.backupCount || 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {backupStatus?.totalSize ? formatBytes(backupStatus.totalSize) : '0 B'} total
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm text-gray-600">Replication Gap</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">
            {gapAnalysis?.totalGapRows?.toLocaleString() || '0'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            rows across {gapAnalysis?.tablesWithGaps || 0} tables
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm text-gray-600">Est. Catchup Time</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">
            {gapAnalysis?.estimatedTotalCatchupTime || 'N/A'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            at current rate
          </div>
        </div>
      </div>

      {/* Subscription Copy Progress */}
      {copyProgress && copyProgress.subscriptions && copyProgress.subscriptions.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">
              Subscription Copy Progress (copy_data=true)
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              Overall: {copyProgress.overallProgress?.completedTables || 0} of {copyProgress.overallProgress?.totalTables || 0} tables complete ({copyProgress.overallProgress?.percentComplete?.toFixed(1) || 0}%)
            </p>
          </div>
          <div className="p-6 space-y-4">
            {copyProgress.subscriptions.map((sub: any, idx: number) => (
              <div key={idx} className="border border-gray-200 rounded-lg p-4">
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-gray-900">{sub.subscriptionName}</h3>
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      sub.status === 'complete' ? 'bg-green-100 text-green-800' :
                      sub.status === 'in_progress' ? 'bg-blue-100 text-blue-800' :
                      sub.status === 'ready' ? 'bg-yellow-100 text-yellow-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {sub.status === 'complete' ? '✓ Complete' :
                       sub.status === 'in_progress' ? '🔄 Copying' :
                       sub.status === 'ready' ? '⏸ Ready' : 'Unknown'}
                    </span>
                  </div>
                  <div className="text-sm font-medium text-gray-900">
                    {sub.percentComplete?.toFixed(1) || 0}%
                  </div>
                </div>
                
                <div className="w-full bg-gray-200 rounded-full h-2 mb-3">
                  <div 
                    className={`h-2 rounded-full transition-all duration-500 ${
                      sub.status === 'complete' ? 'bg-green-600' :
                      sub.status === 'in_progress' ? 'bg-blue-600' :
                      'bg-yellow-600'
                    }`}
                    style={{ width: `${sub.percentComplete || 0}%` }}
                  ></div>
                </div>

                <div className="grid grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-gray-600">Total</div>
                    <div className="font-semibold text-gray-900">{sub.totalTables || 0}</div>
                  </div>
                  <div>
                    <div className="text-gray-600">Done</div>
                    <div className="font-semibold text-green-600">{sub.tablesDone || 0}</div>
                  </div>
                  <div>
                    <div className="text-gray-600">Copying</div>
                    <div className="font-semibold text-blue-600">{sub.tablesInitializing || 0}</div>
                  </div>
                  <div>
                    <div className="text-gray-600">Ready</div>
                    <div className="font-semibold text-yellow-600">{sub.tablesReady || 0}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Replication Gap Analysis */}
      {gapAnalysis && gapAnalysis.largestGaps && gapAnalysis.largestGaps.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">
              Tables with Replication Gaps
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              {gapAnalysis.tablesWithGaps || 0} of {gapAnalysis.totalTables || 0} tables have data gaps
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Table</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Source Rows</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Target Rows</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Gap</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Gap %</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Est. Catchup</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {gapAnalysis.largestGaps.map((gap: any, idx: number) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {gap.schema}.{gap.table}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {gap.sourceRows?.toLocaleString() || 0}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {gap.targetRows?.toLocaleString() || 0}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-red-600">
                      {gap.gap?.toLocaleString() || 0}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600">
                      {gap.gapPercentage?.toFixed(1) || 0}%
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600">
                      {gap.estimatedCatchupTime || 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Backups */}
      {backupStatus && backupStatus.recentBackups && backupStatus.recentBackups.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">Recent Backups</h2>
            <p className="text-sm text-gray-600 mt-1">
              Last {backupStatus.recentBackups.length} backup snapshots
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timestamp</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {backupStatus.recentBackups.map((backup: any, idx: number) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatTimestamp(backup.timestamp)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {formatBytes(backup.size || 0)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600">
                      {backup.duration ? `${Math.floor(backup.duration / 60)}m ${backup.duration % 60}s` : 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        backup.status === 'completed' ? 'bg-green-100 text-green-800' :
                        backup.status === 'running' ? 'bg-blue-100 text-blue-800' :
                        'bg-red-100 text-red-800'
                      }`}>
                        {backup.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
