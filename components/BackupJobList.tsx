import { useState } from 'react';
import TaskLogViewer from './TaskLogViewer';

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

interface BackupJobListProps {
  tasks: BackupTaskInfo[];
  onCancel: (taskId: string) => void;
  onDelete: (taskId: string, hasFile: boolean) => void;
  onCreateSubscription: (taskId: string, subscriptionName: string) => void;
  onReRun: (task: BackupTaskInfo) => void;
  formatBytes: (bytes: number) => string;
}

export default function BackupJobList({
  tasks,
  onCancel,
  onDelete,
  onCreateSubscription,
  onReRun,
  formatBytes,
}: BackupJobListProps) {
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [viewingLogs, setViewingLogs] = useState<{ taskId: string; taskType: 'backup' | 'restore' } | null>(null);

  const toggleExpand = (taskId: string) => {
    const newExpanded = new Set(expandedTasks);
    if (newExpanded.has(taskId)) {
      newExpanded.delete(taskId);
    } else {
      newExpanded.add(taskId);
    }
    setExpandedTasks(newExpanded);
  };

  const getStatusIcon = (status: BackupTaskInfo['status']) => {
    switch (status) {
      case 'completed':
        return <span className="text-green-600 font-bold">✓</span>;
      case 'running':
        return <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-600 border-t-transparent"></div>;
      case 'failed':
        return <span className="text-red-600 font-bold">✗</span>;
      case 'cancelled':
        return <span className="text-gray-500 font-bold">⊘</span>;
      case 'stalled':
        return <span className="text-orange-600 font-bold">⚠</span>;
      case 'pending':
        return <span className="text-yellow-600 font-bold">○</span>;
      default:
        return <span className="text-gray-400">○</span>;
    }
  };

  const getStatusColor = (status: BackupTaskInfo['status']) => {
    switch (status) {
      case 'completed':
        return 'bg-green-50 border-green-200 text-green-800';
      case 'running':
        return 'bg-blue-50 border-blue-200 text-blue-800';
      case 'failed':
        return 'bg-red-50 border-red-200 text-red-800';
      case 'cancelled':
        return 'bg-gray-50 border-gray-200 text-gray-600';
      case 'stalled':
        return 'bg-orange-50 border-orange-200 text-orange-800';
      case 'pending':
        return 'bg-yellow-50 border-yellow-200 text-yellow-800';
      default:
        return 'bg-gray-50 border-gray-200 text-gray-600';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getDuration = (started?: string, completed?: string) => {
    if (!started) return 'N/A';
    const start = new Date(started);
    const end = completed ? new Date(completed) : new Date();
    const seconds = Math.floor((end.getTime() - start.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  };

  if (tasks.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <div className="text-gray-400 text-6xl mb-4">📦</div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">No Backup Jobs</h3>
        <p className="text-gray-500">Create a backup to see jobs here</p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Backup Jobs</h2>
            <span className="text-sm text-gray-500">{tasks.length} job{tasks.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Job List */}
        <div className="divide-y divide-gray-200">
          {tasks.map((task) => {
            const isExpanded = expandedTasks.has(task.id);
            const isSnapshot = !!(task.slot_name || task.snapshot_id);
            const isRunning = task.status === 'running' || task.status === 'pending';

            return (
              <div
                key={task.id}
                className={`transition-colors ${
                  isRunning ? 'bg-blue-50/30' : 'bg-white'
                } hover:bg-gray-50`}
              >
                {/* Main Job Row */}
                <div className="px-6 py-4">
                  <div className="flex items-center justify-between">
                    {/* Left: Status and Info */}
                    <div className="flex items-center space-x-4 flex-1 min-w-0">
                      {/* Status Icon */}
                      <div className="flex-shrink-0">
                        {getStatusIcon(task.status)}
                      </div>

                      {/* Job Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-3">
                          <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${getStatusColor(task.status)}`}>
                            {task.status.toUpperCase()}
                          </span>
                          <span className="text-sm font-medium text-gray-900">
                            {task.task_type === 'backup' ? 'Backup' : 'Restore'}
                            {task.schema_only && ' (Schema Only)'}
                            {isSnapshot && ' • With Replication'}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center space-x-4 text-xs text-gray-500">
                          <span>ID: <span className="font-mono">{task.id.substring(0, 8)}...</span></span>
                          {task.filename && (
                            <span className="font-mono truncate max-w-xs">{task.filename}</span>
                          )}
                          {task.file_size && (
                            <span>{formatBytes(task.file_size)}</span>
                          )}
                          {task.started_at && (
                            <span>Started: {formatDate(task.started_at)}</span>
                          )}
                          {task.started_at && (
                            <span>Duration: {getDuration(task.started_at, task.completed_at)}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center space-x-2 flex-shrink-0 ml-4">
                      {/* View Logs - Always Available */}
                      <button
                        onClick={() => setViewingLogs({ taskId: task.id, taskType: task.task_type })}
                        className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 transition-colors"
                        title="View logs"
                      >
                        📋 Logs
                      </button>

                      {/* Expand/Collapse */}
                      <button
                        onClick={() => toggleExpand(task.id)}
                        className="px-2 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                        title={isExpanded ? 'Collapse details' : 'Expand details'}
                      >
                        {isExpanded ? '▲' : '▼'}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
                      {/* Metadata */}
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="font-medium text-gray-700">Created:</span>
                          <span className="ml-2 text-gray-600">{formatDate(task.created_at)}</span>
                        </div>
                        {task.completed_at && (
                          <div>
                            <span className="font-medium text-gray-700">Completed:</span>
                            <span className="ml-2 text-gray-600">{formatDate(task.completed_at)}</span>
                          </div>
                        )}
                        {task.tables && task.tables.length > 0 && (
                          <div className="col-span-2">
                            <span className="font-medium text-gray-700">Tables ({task.tables.length}):</span>
                            <div className="mt-1 text-gray-600 font-mono text-xs flex flex-wrap gap-1">
                              {task.tables.map((t, idx) => (
                                <span key={idx} className="px-1.5 py-0.5 bg-gray-100 rounded">
                                  {t.replace(/^public\./, '').replace(/^"/, '').replace(/"$/, '')}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {task.exclude_tables && task.exclude_tables.length > 0 && (
                          <div className="col-span-2">
                            <span className="font-medium text-gray-700">Excluded Tables ({task.exclude_tables.length}):</span>
                            <div className="mt-1 text-gray-600 font-mono text-xs flex flex-wrap gap-1">
                              {task.exclude_tables.map((t, idx) => (
                                <span key={idx} className="px-1.5 py-0.5 bg-orange-100 rounded">
                                  {t.replace(/^public\./, '').replace(/^"/, '').replace(/"$/, '')}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* File and Log Paths */}
                      <div className="bg-gray-50 border border-gray-200 rounded p-3">
                        <h4 className="text-sm font-semibold text-gray-900 mb-2">File & Log Paths</h4>
                        <div className="space-y-1 text-xs">
                          {task.filepath ? (
                            <div>
                              <span className="font-medium text-gray-700">Backup File:</span>
                              <div className="mt-1 font-mono text-gray-600 break-all bg-white p-1 rounded border">
                                {task.filepath}
                              </div>
                            </div>
                          ) : (
                            <div className="text-gray-500 italic">File path will be set when backup starts...</div>
                          )}
                          <div className="mt-2">
                            <span className="font-medium text-gray-700">Log Files:</span>
                            <div className="mt-1 space-y-1">
                              <div className="font-mono text-gray-600 text-xs break-all bg-white p-1 rounded border">
                                /tmp/backup-logs/{task.id}.stdout.log
                              </div>
                              <div className="font-mono text-gray-600 text-xs break-all bg-white p-1 rounded border">
                                /tmp/backup-logs/{task.id}.stderr.log
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Error Message */}
                      {task.error_message && (
                        <div className="bg-red-50 border border-red-200 rounded p-3">
                          <h4 className="text-sm font-semibold text-red-900 mb-2">Error</h4>
                          <div className="text-xs text-red-800 font-mono break-all">
                            {task.error_message}
                          </div>
                        </div>
                      )}

                      {/* Replication Info */}
                      {isSnapshot && (
                        <div className="bg-blue-50 border border-blue-200 rounded p-3">
                          <h4 className="text-sm font-semibold text-blue-900 mb-2">Replication Information</h4>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            {task.slot_name && (
                              <div>
                                <span className="font-medium text-blue-700">Slot:</span>
                                <span className="ml-2 font-mono text-blue-900">{task.slot_name}</span>
                              </div>
                            )}
                            {task.publication_name && (
                              <div>
                                <span className="font-medium text-blue-700">Publication:</span>
                                <span className="ml-2 font-mono text-blue-900">{task.publication_name}</span>
                              </div>
                            )}
                            {task.slot_initial_lsn && (
                              <div>
                                <span className="font-medium text-blue-700">Initial LSN:</span>
                                <span className="ml-2 font-mono text-blue-900">{task.slot_initial_lsn}</span>
                              </div>
                            )}
                            {task.snapshot_id && (
                              <div>
                                <span className="font-medium text-blue-700">Snapshot ID:</span>
                                <span className="ml-2 font-mono text-blue-900">{task.snapshot_id}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Error Message */}
                      {task.error_message && (
                        <div className="bg-red-50 border border-red-200 rounded p-3">
                          <h4 className="text-sm font-semibold text-red-900 mb-1">Error</h4>
                          <p className="text-xs text-red-700 font-mono">{task.error_message}</p>
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="flex items-center space-x-2 pt-2 border-t border-gray-200">
                    {(task.status === 'running' || task.status === 'pending') && (
                      <button
                        onClick={() => onCancel(task.id)}
                        className="px-3 py-1.5 text-xs font-medium text-yellow-700 bg-yellow-50 border border-yellow-200 rounded hover:bg-yellow-100 transition-colors"
                      >
                        Cancel Job
                      </button>
                    )}
                    {task.status === 'completed' && task.task_type === 'backup' && (
                      <button
                        onClick={() => onReRun(task)}
                        className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 transition-colors"
                      >
                        ↻ Re-run
                      </button>
                    )}
                    {task.status === 'completed' && task.slot_name && (
                      <button
                        onClick={() => {
                          const defaultName = task.slot_name
                            ? `subscription_${task.slot_name.replace('backup_slot_', '')}`
                            : 'subscription';
                          const subName = prompt('Enter subscription name:', defaultName);
                          if (subName) {
                            onCreateSubscription(task.id, subName);
                          }
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded hover:bg-green-100 transition-colors"
                      >
                        Create Subscription
                      </button>
                    )}
                        {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'stalled') && (
                          <button
                            onClick={() => onDelete(task.id, !!task.filepath)}
                            className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors"
                          >
                            Delete Job
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Log Viewer Modal */}
      {viewingLogs && (
        <TaskLogViewer
          taskId={viewingLogs.taskId}
          taskType={viewingLogs.taskType}
          isOpen={!!viewingLogs}
          onClose={() => setViewingLogs(null)}
        />
      )}
    </>
  );
}

