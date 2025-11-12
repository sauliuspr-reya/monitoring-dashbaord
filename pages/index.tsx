import { useState, useEffect } from 'react';
import { ReplicationStatus, Alert } from '@/lib/types';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Navbar from '@/components/Navbar';

export default function Dashboard() {
  const router = useRouter();
  const [groups, setGroups] = useState<ReplicationStatus[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [tableStats, setTableStats] = useState<{
    total: number;
    replicated: number;
    notReplicated: number;
    atRisk: number;
  } | null>(null);

  // Don't redirect - show simplified dashboard

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      // Load groups
      const groupsRes = await fetch('/api/groups');
      const groupsData = await groupsRes.json();

      // Load status for each group
      const statusPromises = groupsData.map((group: any) =>
        fetch(`/api/groups/${group.id}/status`).then((res) => res.json())
      );
      const statuses = await Promise.all(statusPromises);
      setGroups(statuses);

      // Load table stats for overview
      try {
        const tablesRes = await fetch('/api/tables/all');
        const tablesData = await tablesRes.json();
        const tables = tablesData.tables || [];
        
        const replicated = tables.filter((t: any) => t.subscriptions && t.subscriptions.length > 0).length;
        const atRisk = tables.filter((t: any) => t.writersOnBoth).length;
        
        setTableStats({
          total: tables.length,
          replicated,
          notReplicated: tables.length - replicated,
          atRisk,
        });
      } catch (err) {
        console.warn('Could not load table stats:', err);
      }

      // Load alerts
      const alertsRes = await fetch('/api/alerts?acknowledged=false');
      const alertsData = await alertsRes.json();
      setAlerts(alertsData);

      setLoading(false);
    } catch (error) {
      console.error('Error loading data:', error);
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

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'text-red-800 bg-red-100';
      case 'error':
        return 'text-red-700 bg-red-50';
      case 'warning':
        return 'text-yellow-700 bg-yellow-50';
      default:
        return 'text-blue-700 bg-blue-50';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              AWS RDS → GCP Cloud SQL Migration
            </h1>
            <p className="mt-2 text-gray-600">
              Identify which tables need to be replicated. Detect services writing to source vs destination.
            </p>
          </div>

          {/* Overview Metrics */}
          {tableStats && (
            <div className="mb-8 grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white rounded-lg shadow p-6">
                <div className="text-sm text-gray-500 mb-1">Total Tables</div>
                <div className="text-3xl font-bold text-gray-900">{tableStats.total}</div>
              </div>
              <div className="bg-white rounded-lg shadow p-6">
                <div className="text-sm text-gray-500 mb-1">Replicated</div>
                <div className="text-3xl font-bold text-green-600">{tableStats.replicated}</div>
              </div>
              <div className="bg-white rounded-lg shadow p-6">
                <div className="text-sm text-gray-500 mb-1">Not Replicated</div>
                <div className="text-3xl font-bold text-gray-600">{tableStats.notReplicated}</div>
              </div>
              <div className="bg-white rounded-lg shadow p-6">
                <div className="text-sm text-gray-500 mb-1">⚠️ At Risk</div>
                <div className="text-3xl font-bold text-red-600">{tableStats.atRisk}</div>
                <div className="text-xs text-gray-500 mt-1">Writers on both sides</div>
              </div>
            </div>
          )}

          {/* Quick Actions */}
          <div className="mb-8 flex gap-3">
            <Link
              href="/tables"
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
            >
              View All Tables
            </Link>
            <Link
              href="/services"
              className="px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 font-medium"
            >
              View Services
            </Link>
            <Link
              href="/subscriptions/new"
              className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium"
            >
              Setup Replication
            </Link>
          </div>

        {/* Alerts Section */}
        {alerts.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Active Alerts</h2>
            <div className="space-y-2">
              {alerts.slice(0, 5).map((alert) => (
                <div
                  key={alert.id}
                  className={`p-4 rounded-lg ${getSeverityColor(alert.severity)}`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium">{alert.alertType.toUpperCase()}</div>
                      <div className="text-sm mt-1">{alert.message}</div>
                      {alert.tableName && (
                        <div className="text-xs mt-1">Table: {alert.tableName}</div>
                      )}
                    </div>
                    <div className="text-xs text-gray-600">
                      {new Date(alert.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Subscriptions Section */}
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-gray-900">Subscriptions</h2>
            <div className="flex gap-2">
              <Link
                href="/tables"
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
              >
                View All Tables
              </Link>
              <Link
                href="/subscriptions/new"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Create Subscription
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6">
            {groups.map((group) => (
              <div
                key={(group as any).subscriptionId || (group as any).groupId}
                className="bg-white rounded-lg shadow p-6"
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {(group as any).subscriptionName || (group as any).groupName}
                    </h3>
                    <div className="mt-1">
                      <span
                        className={`px-2 py-1 rounded text-sm font-medium ${getStatusColor(
                          group.status || 'stopped'
                        )}`}
                      >
                        {(group.status || 'stopped').toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <div className="text-right text-sm text-gray-600">
                    <div>Enabled: {group.enabled ? 'Yes' : 'No'}</div>
                    <div>Worker: {group.workerRunning ? 'Running' : 'Stopped'}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                  <div>
                    <div className="text-xs text-gray-500">Replication Lag</div>
                    <div className="text-lg font-semibold">
                      {formatBytes(group.lagBytes)}
                    </div>
                    {group.lagSeconds > 0 && (
                      <div className="text-xs text-gray-500">
                        {group.lagSeconds}s behind
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Slot Lag</div>
                    <div className="text-lg font-semibold">
                      {formatBytes(group.slotLagBytes)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Tables</div>
                    <div className="text-lg font-semibold">{group.tableCount}</div>
                    {group.tablesWithIssues > 0 && (
                      <div className="text-xs text-red-600">
                        {group.tablesWithIssues} with issues
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Conflicts</div>
                    <div className={`text-lg font-semibold ${group.conflicts > 0 ? 'text-red-600' : ''}`}>
                      {group.conflicts}
                    </div>
                  </div>
                </div>

                {group.lastAppliedAt && (
                  <div className="mt-4 text-xs text-gray-500">
                    Last applied: {new Date(group.lastAppliedAt).toLocaleString()}
                  </div>
                )}

                <div className="mt-4">
                  <Link
                    href={`/subscriptions/${(group as any).subscriptionId || (group as any).groupId}`}
                    className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                  >
                    View Details →
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {groups.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No subscriptions configured. Add your first subscription to get started.
            </div>
          )}
        </div>
        </div>
      </div>
    </>
  );
}

