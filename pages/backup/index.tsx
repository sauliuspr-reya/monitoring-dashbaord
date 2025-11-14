import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Navbar from '@/components/Navbar';
import BackupJobList from '@/components/BackupJobList';
import CompletedBackupsList from '@/components/CompletedBackupsList';
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
  
  // Tab state for jobs list
  const [jobsTab, setJobsTab] = useState<'all' | 'backup' | 'restore'>('all');
  


  useEffect(() => {
    loadTables();
    loadBackups();
    loadBackupTasks();
  }, []);

  useEffect(() => {
    // Refresh tasks every 30 seconds if there are running or pending tasks (both backup and restore)
    const interval = setInterval(() => {
      const hasRunningTasks = backupTasks.some(t => 
        (t.status === 'running' || t.status === 'pending') && 
        (t.task_type === 'backup' || t.task_type === 'restore')
      );
      if (hasRunningTasks) {
        console.log('[BackupPage] Auto-refreshing tasks (running/pending tasks detected)');
        loadBackupTasks();
      }
    }, 30000); // 30 seconds

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
      // Load all backup and restore tasks (no limit to show all)
      const res = await fetch('/api/backup/tasks');
      if (res.ok) {
        const data = await res.json();
        setBackupTasks(data.tasks || []);
        console.log('[BackupPage] Loaded tasks:', data.tasks?.length || 0, 'tasks');
      } else {
        console.error('[BackupPage] Failed to load tasks:', res.status, res.statusText);
      }
    } catch (err: any) {
      console.error('[BackupPage] Error loading tasks:', err);
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

      console.log('[BackupPage] Initiating restore for:', filename);

      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename,
          dryRun: false,
        }),
      });

      const data = await res.json();

      console.log('[BackupPage] Restore response:', { status: res.status, data });

      if (res.ok) {
        if (data.taskId) {
          setSuccess(`Restore task created (ID: ${data.taskId.substring(0, 8)}...). Restore in progress...`);
          setShowRestoreModal(false);
          
          // Immediately refresh task list to show the new restore task
          console.log('[BackupPage] Refreshing task list after restore creation...');
          await loadBackupTasks();
          
          // Also set up polling to refresh while restore is running
          let pollCount = 0;
          const maxPolls = 120; // 60 minutes at 30 second intervals
          const checkInterval = setInterval(async () => {
            pollCount++;
            await loadBackupTasks();
            
            // After loading, check the updated task list
            const updatedTasks = await fetch('/api/backup/tasks').then(r => r.json()).catch(() => ({ tasks: [] }));
            const restoreTask = updatedTasks.tasks?.find((t: any) => t.id === data.taskId);
            
            if (restoreTask && (restoreTask.status === 'completed' || restoreTask.status === 'failed' || restoreTask.status === 'cancelled')) {
              console.log(`[BackupPage] Restore task ${data.taskId} finished with status: ${restoreTask.status}`);
              clearInterval(checkInterval);
            } else if (pollCount >= maxPolls) {
              console.log(`[BackupPage] Stopping restore polling after ${maxPolls} checks`);
              clearInterval(checkInterval);
            }
          }, 30000); // Poll every 30 seconds
        } else {
          setError('Restore task created but no task ID returned');
        }
      } else {
        setError(data.error || 'Failed to restore backup');
        console.error('[BackupPage] Restore failed:', data);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to restore backup');
      console.error('[BackupPage] Restore error:', err);
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

          {/* Jobs Section */}
          <div className="mb-8">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Jobs</h2>
                <p className="text-sm text-gray-600 mt-1">
                  Backup and restore task history
                </p>
              </div>
              <button
                onClick={loadBackupTasks}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                ↻ Refresh
              </button>
            </div>

            {/* Tabs */}
            <div className="mb-4 border-b border-gray-200">
              <nav className="-mb-px flex space-x-8">
                <button
                  onClick={() => setJobsTab('all')}
                  className={`py-3 px-1 border-b-2 font-medium text-sm ${
                    jobsTab === 'all'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  All Jobs
                  <span className="ml-2 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                    {backupTasks.length}
                  </span>
                </button>
                <button
                  onClick={() => setJobsTab('backup')}
                  className={`py-3 px-1 border-b-2 font-medium text-sm ${
                    jobsTab === 'backup'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Backup Tasks
                  <span className="ml-2 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                    {backupTasks.filter(t => t.task_type === 'backup').length}
                  </span>
                </button>
                <button
                  onClick={() => setJobsTab('restore')}
                  className={`py-3 px-1 border-b-2 font-medium text-sm ${
                    jobsTab === 'restore'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Restore Tasks
                  <span className="ml-2 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                    {backupTasks.filter(t => t.task_type === 'restore').length}
                  </span>
                </button>
              </nav>
            </div>

            {loadingTasks ? (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
                <p className="text-gray-500">Loading jobs...</p>
              </div>
            ) : (
              <BackupJobList
                tasks={
                  jobsTab === 'all'
                    ? backupTasks
                    : jobsTab === 'backup'
                    ? backupTasks.filter(t => t.task_type === 'backup')
                    : backupTasks.filter(t => t.task_type === 'restore')
                }
                onCancel={handleCancelTask}
                onDelete={handleDeleteTask}
                onCreateSubscription={handleCreateSubscriptionFromBackup}
                formatBytes={formatBytes}
              />
            )}
          </div>

          {/* Completed Backups Section */}
          <div className="mb-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Completed Backups</h2>
                <p className="text-sm text-gray-600 mt-1">
                  Backup files available for restore from filesystem
                </p>
              </div>
              <button
                onClick={loadBackups}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                ↻ Refresh
              </button>
            </div>

            <CompletedBackupsList
              backups={backups}
              loading={loadingBackups}
              onRestore={handleRestoreFromModal}
              restoring={restoring}
              formatBytes={formatBytes}
            />
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
