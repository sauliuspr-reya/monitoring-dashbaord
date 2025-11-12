import { useState } from 'react';
import Navbar from '@/components/Navbar';
import Link from 'next/link';

interface MigrationResult {
  success: boolean;
  dropped: {
    publication: boolean;
    subscription: boolean;
    slot: boolean;
    monitoring: boolean;
  };
  created: Array<{
    name: string;
    publication: string;
    subscription: string;
    tables: number;
    success: boolean;
    error?: string;
  }>;
  summary: {
    totalGroups: number;
    successful: number;
    failed: number;
    totalTables: number;
  };
  errors?: string[];
}

export default function MigrateSubscriptionsPage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [dropOld, setDropOld] = useState(true);
  const [createNew, setCreateNew] = useState(true);

  const handleMigrate = async () => {
    if (!confirm('This will drop the old reya_replication subscription and create new domain-based subscriptions. Continue?')) {
      return;
    }

    try {
      setLoading(true);
      setResult(null);

      // Get connection strings
      const connectionsRes = await fetch('/api/config/connections');
      const connections = await connectionsRes.ok ? await connectionsRes.json() : null;

      if (!connections || !connections.sourceDbConnection || !connections.targetDbConnection) {
        alert('Could not get database connection strings. Please ensure connections are configured.');
        return;
      }

      const res = await fetch('/api/subscriptions/migrate-to-domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceDbConnection: connections.sourceDbConnection,
          targetDbConnection: connections.targetDbConnection,
          dropOld,
          createNew,
        }),
      });

      const data = await res.json();
      setResult(data);
    } catch (error: any) {
      alert(`Error: ${error.message || 'Failed to migrate subscriptions'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-6 sm:px-8 lg:px-12 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Migrate to Domain-Based Subscriptions</h1>
            <p className="mt-2 text-gray-600">
              This will remove the old <code className="bg-gray-100 px-1 rounded">reya_replication</code> subscription
              and create new subscriptions organized by business domain.
            </p>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-yellow-900 mb-2">⚠️ Important</h2>
            <ul className="list-disc list-inside text-yellow-800 space-y-1">
              <li>This will drop the existing <code className="bg-yellow-100 px-1 rounded">reya_replication</code> publication and subscription</li>
              <li>All tables will be reorganized into domain-based subscriptions</li>
              <li>Goldsky tables will be automatically excluded</li>
              <li>Make sure you have backups before proceeding</li>
            </ul>
          </div>

          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Migration Options</h2>
            <div className="space-y-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={dropOld}
                  onChange={(e) => setDropOld(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-gray-700">Drop old reya_replication subscription and publication</span>
              </label>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={createNew}
                  onChange={(e) => setCreateNew(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-gray-700">Create new domain-based subscriptions</span>
              </label>
            </div>
          </div>

          <div className="flex gap-4 mb-6">
            <button
              onClick={handleMigrate}
              disabled={loading || (!dropOld && !createNew)}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              {loading ? 'Migrating...' : 'Start Migration'}
            </button>
            <Link
              href="/subscriptions"
              className="px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-medium"
            >
              Cancel
            </Link>
          </div>

          {result && (
            <div className="space-y-6">
              <div className={`bg-white rounded-lg shadow p-6 ${result.success ? 'border-l-4 border-green-500' : 'border-l-4 border-red-500'}`}>
                <h2 className={`text-lg font-semibold mb-4 ${result.success ? 'text-green-900' : 'text-red-900'}`}>
                  {result.success ? '✓ Migration Completed' : '✗ Migration Completed with Errors'}
                </h2>
                
                {result.dropped && (
                  <div className="mb-4">
                    <h3 className="font-medium text-gray-900 mb-2">Dropped:</h3>
                    <ul className="list-disc list-inside text-gray-600 space-y-1">
                      {result.dropped.publication && <li>Publication: reya_replication</li>}
                      {result.dropped.subscription && <li>Subscription: reya_replication</li>}
                      {result.dropped.slot && <li>Replication slot: reya_replication_slot</li>}
                      {result.dropped.monitoring && <li>Monitoring database entry</li>}
                    </ul>
                  </div>
                )}

                {result.summary && (
                  <div className="mb-4">
                    <h3 className="font-medium text-gray-900 mb-2">Summary:</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="bg-gray-50 p-3 rounded">
                        <div className="text-sm text-gray-500">Total Groups</div>
                        <div className="text-2xl font-bold text-gray-900">{result.summary.totalGroups}</div>
                      </div>
                      <div className="bg-green-50 p-3 rounded">
                        <div className="text-sm text-green-600">Successful</div>
                        <div className="text-2xl font-bold text-green-600">{result.summary.successful}</div>
                      </div>
                      <div className="bg-red-50 p-3 rounded">
                        <div className="text-sm text-red-600">Failed</div>
                        <div className="text-2xl font-bold text-red-600">{result.summary.failed}</div>
                      </div>
                      <div className="bg-blue-50 p-3 rounded">
                        <div className="text-sm text-blue-600">Total Tables</div>
                        <div className="text-2xl font-bold text-blue-600">{result.summary.totalTables}</div>
                      </div>
                    </div>
                  </div>
                )}

                {result.errors && result.errors.length > 0 && (
                  <div className="mb-4">
                    <h3 className="font-medium text-red-900 mb-2">Errors:</h3>
                    <ul className="list-disc list-inside text-red-700 space-y-1">
                      {result.errors.map((error, idx) => (
                        <li key={idx}>{error}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {result.created && result.created.length > 0 && (
                <div className="bg-white rounded-lg shadow overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200">
                    <h3 className="text-lg font-semibold text-gray-900">Created Subscriptions</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Domain</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Publication</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Subscription</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Tables</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {result.created.map((item) => (
                          <tr key={item.name} className="hover:bg-gray-50">
                            <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                              {item.name}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-600">
                              {item.publication}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-600">
                              {item.subscription}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                              {item.tables}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-center">
                              {item.success ? (
                                <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">Success</span>
                              ) : (
                                <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded" title={item.error}>
                                  Failed
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

