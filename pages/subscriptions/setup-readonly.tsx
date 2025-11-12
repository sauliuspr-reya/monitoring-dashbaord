import { useState, useEffect } from 'react';
import Navbar from '@/components/Navbar';
import Link from 'next/link';

interface TableWithoutWriter {
  tableName: string;
  schema: string;
  table: string;
  reason: 'no_writers' | 'read_only' | 'replication_only';
  existingSubscription?: string;
  isGoldsky?: boolean;
}

export default function SetupReadonlyTablesPage() {
  const [tables, setTables] = useState<TableWithoutWriter[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [subscriptionName, setSubscriptionName] = useState('readonly_tables');
  const [subscriptionDescription, setSubscriptionDescription] = useState('Tables without active writers');

  useEffect(() => {
    loadTables();
  }, []);

  const loadTables = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/tables/without-writers');
      if (res.ok) {
        const data = await res.json();
        setTables(data.tables || []);
        setStats(data.stats);
      }
    } catch (error) {
      console.error('Error loading tables:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleTable = (tableName: string) => {
    const newSelected = new Set(selectedTables);
    if (newSelected.has(tableName)) {
      newSelected.delete(tableName);
    } else {
      newSelected.add(tableName);
    }
    setSelectedTables(newSelected);
  };

  const selectAll = () => {
    setSelectedTables(new Set(tables.map(t => t.tableName)));
  };

  const deselectAll = () => {
    setSelectedTables(new Set());
  };

  const createSubscription = async () => {
    if (selectedTables.size === 0) {
      alert('Please select at least one table');
      return;
    }

    if (!subscriptionName.trim()) {
      alert('Please enter a subscription name');
      return;
    }

    try {
      setCreating(true);

      // Get connection strings from first subscription
      const connectionsRes = await fetch('/api/config/connections');
      const connections = await connectionsRes.ok ? await connectionsRes.json() : null;

      if (!connections || !connections.sourceDbConnection || !connections.targetDbConnection) {
        alert('Could not get database connection strings. Please create a subscription first to set up connections.');
        return;
      }

      const tablesArray = Array.from(selectedTables);
      const res = await fetch('/api/subscriptions/create-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: subscriptionName,
          description: subscriptionDescription,
          tables: tablesArray,
          sourceDbConnection: connections.sourceDbConnection,
          targetDbConnection: connections.targetDbConnection,
          createPublication: true,
          createSubscription: true,
        }),
      });

      if (res.ok) {
        const result = await res.json();
        alert(`Successfully created subscription "${result.name}" with ${result.tables} tables!`);
        // Reload tables to update the list
        await loadTables();
        setSelectedTables(new Set());
      } else {
        const error = await res.json();
        alert(`Failed to create subscription: ${error.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      console.error('Error creating subscription:', error);
      alert(`Error: ${error.message || 'Failed to create subscription'}`);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-gray-600">Loading tables...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-6 sm:px-8 lg:px-12 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Setup Subscriptions for Read-Only Tables</h1>
            <p className="mt-2 text-gray-600">
              These tables are not being written to by any services (indexers, APIs, etc.) and are safe to replicate.
            </p>
            {stats && (
              <div className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="bg-white p-4 rounded-lg shadow">
                  <div className="text-sm text-gray-500">Total Tables</div>
                  <div className="text-2xl font-bold text-gray-900">{stats.totalTablesInDb}</div>
                </div>
                <div className="bg-white p-4 rounded-lg shadow">
                  <div className="text-sm text-gray-500">With Writers</div>
                  <div className="text-2xl font-bold text-blue-600">{stats.tablesWithWriters}</div>
                </div>
                <div className="bg-white p-4 rounded-lg shadow">
                  <div className="text-sm text-gray-500">In Subscriptions</div>
                  <div className="text-2xl font-bold text-green-600">{stats.tablesInSubscriptions}</div>
                </div>
                <div className="bg-white p-4 rounded-lg shadow">
                  <div className="text-sm text-gray-500">Goldsky Tables</div>
                  <div className="text-2xl font-bold text-purple-600">{stats.goldskyTables}</div>
                </div>
                <div className="bg-white p-4 rounded-lg shadow">
                  <div className="text-sm text-gray-500">Without Writers</div>
                  <div className="text-2xl font-bold text-orange-600">{stats.tablesWithoutWriters}</div>
                </div>
              </div>
            )}
          </div>

          {tables.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-12 text-center">
              <p className="text-gray-500">No tables found without active writers</p>
              <p className="text-sm text-gray-400 mt-2">
                All tables either have active writers or are already in subscriptions.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">
                  Create Subscription for Selected Tables ({selectedTables.size} selected)
                </h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Subscription Name
                    </label>
                    <input
                      type="text"
                      value={subscriptionName}
                      onChange={(e) => setSubscriptionName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="readonly_tables"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description (optional)
                    </label>
                    <input
                      type="text"
                      value={subscriptionDescription}
                      onChange={(e) => setSubscriptionDescription(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Tables without active writers"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={createSubscription}
                      disabled={creating || selectedTables.size === 0}
                      className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {creating ? 'Creating...' : `Create Subscription (${selectedTables.size} tables)`}
                    </button>
                    <button
                      onClick={selectAll}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
                    >
                      Select All
                    </button>
                    <button
                      onClick={deselectAll}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
                    >
                      Deselect All
                    </button>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200">
                  <h2 className="text-lg font-semibold text-gray-900">
                    Tables Without Active Writers ({tables.length})
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-12">
                          <input
                            type="checkbox"
                            checked={selectedTables.size === tables.length && tables.length > 0}
                            onChange={(e) => e.target.checked ? selectAll() : deselectAll()}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Table Name
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Reason
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {tables.map((table) => (
                        <tr key={table.tableName} className="hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap">
                            <input
                              type="checkbox"
                              checked={selectedTables.has(table.tableName)}
                              onChange={() => toggleTable(table.tableName)}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-900">
                            <Link
                              href={`/tables?filter=${table.table}`}
                              className="text-blue-600 hover:text-blue-800"
                            >
                              {table.table}
                            </Link>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                            <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">
                              No active writers
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

