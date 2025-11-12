import { useState, useEffect } from 'react';
import Link from 'next/link';

interface BackupSnapshot {
  id: string;
  timestamp: Date;
  size: number;
  duration: number;
  status: 'completed' | 'running' | 'failed';
}

interface BackupStatus {
  lastBackup?: BackupSnapshot;
  nextScheduled?: Date;
  backupCount: number;
  totalSize: number;
  oldestBackup?: Date;
  newestBackup?: Date;
  averageDuration: number;
  recentBackups: BackupSnapshot[];
  message?: string;
}

interface TableGap {
  schema: string;
  table: string;
  sourceRows: number;
  targetRows: number;
  gap: number;
  gapPercentage: number;
  estimatedCatchupTime?: string;
}

interface GapAnalysis {
  totalTables: number;
  tablesWithGaps: number;
  totalGapRows: number;
  largestGaps: TableGap[];
  replicationMode: string;
  estimatedTotalCatchupTime?: string;
  message?: string;
}

interface SubscriptionProgress {
  subscriptionName: string;
  totalTables: number;
  tablesReady: number;
  tablesInitializing: number;
  tablesDone: number;
  tablesSyncing: number;
  percentComplete: number;
  status: 'complete' | 'in_progress' | 'ready' | 'unknown';
}

interface CopyProgress {
  subscriptions: SubscriptionProgress[];
  overallProgress: {
    totalSubscriptions: number;
    completedSubscriptions: number;
    inProgressSubscriptions: number;
    totalTables: number;
    completedTables: number;
    percentComplete: number;
  };
}

export default function BackupsPage() {
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30 seconds
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

  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
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
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Backup & Replication Monitor</h1>
            <p className="text-gray-600 mt-1">Track backup progress and replication gaps</p>
          </div>
          <Link href="/" className="text-blue-600 hover:text-blue-800">
            ← Back to Dashboard
          </Link>
        </div>

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
        {copyProgress && copyProgress.subscriptions.length > 0 && (
          <div className="bg-white rounded-lg shadow">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">
                Subscription Copy Progress (copy_data=true)
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                Overall: {copyProgress.overallProgress.completedTables} of {copyProgress.overallProgress.totalTables} tables complete ({copyProgress.overallProgress.percentComplete.toFixed(1)}%)
              </p>
            </div>
            <div className="p-6 space-y-4">
              {copyProgress.subscriptions.map((sub, idx) => (
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
                      {sub.percentComplete.toFixed(1)}%
                    </div>
                  </div>
                  
                  {/* Progress bar */}
                  <div className="w-full bg-gray-200 rounded-full h-2 mb-3">
                    <div 
                      className={`h-2 rounded-full transition-all duration-500 ${
                        sub.status === 'complete' ? 'bg-green-600' :
                        sub.status === 'in_progress' ? 'bg-blue-600' :
                        'bg-yellow-600'
                      }`}
                      style={{ width: `${sub.percentComplete}%` }}
                    ></div>
                  </div>

                  {/* Table counts */}
                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-gray-600">Total</div>
                      <div className="font-semibold text-gray-900">{sub.totalTables}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Done</div>
                      <div className="font-semibold text-green-600">{sub.tablesDone}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Copying</div>
                      <div className="font-semibold text-blue-600">{sub.tablesInitializing}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Ready</div>
                      <div className="font-semibold text-yellow-600">{sub.tablesReady}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Replication Gap Analysis */}
        {gapAnalysis && gapAnalysis.largestGaps.length > 0 && (
          <div className="bg-white rounded-lg shadow">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">
                Tables with Replication Gaps
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                {gapAnalysis.tablesWithGaps} of {gapAnalysis.totalTables} tables have data gaps
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Table
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Source Rows
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Target Rows
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Gap
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Gap %
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Est. Catchup
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {gapAnalysis.largestGaps.map((gap, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {gap.schema}.{gap.table}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                        {gap.sourceRows.toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                        {gap.targetRows.toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-red-600">
                        {gap.gap.toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600">
                        {gap.gapPercentage.toFixed(1)}%
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
        {backupStatus && backupStatus.recentBackups.length > 0 && (
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
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Snapshot ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Timestamp
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Size
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Duration
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {backupStatus.recentBackups.map((backup, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-600">
                        {backup.id.substring(0, 12)}...
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {formatTimestamp(backup.timestamp)}
                        <div className="text-xs text-gray-500">{getTimeAgo(backup.timestamp)}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                        {formatBytes(backup.size)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                        {formatDuration(backup.duration)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
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

        {/* Empty States */}
        {backupStatus?.message && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
            <p className="text-yellow-800">{backupStatus.message}</p>
          </div>
        )}

        {gapAnalysis?.message && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
            <p className="text-yellow-800">{gapAnalysis.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
