import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Navbar from '@/components/Navbar';

export default function NewSubscription() {
  const router = useRouter();
  const [allTables, setAllTables] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceDbConnection, setSourceDbConnection] = useState('');
  const [targetDbConnection, setTargetDbConnection] = useState('');
  const [defaultSourceConnection, setDefaultSourceConnection] = useState('');
  const [defaultTargetConnection, setDefaultTargetConnection] = useState('');
  const [useCustomConnections, setUseCustomConnections] = useState(false);
  const [dataCopy, setDataCopy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTables();
    loadConnectionStrings();
  }, []);

  useEffect(() => {
    // Check if tables are pre-selected from query params
    if (router.query.tables) {
      const preSelectedTables = (router.query.tables as string).split(',').filter(Boolean);
      if (preSelectedTables.length > 0) {
        setSelectedTables(preSelectedTables);
        // Pre-fill name if not set
        if (preSelectedTables.length > 0) {
          setName(prev => prev || `Subscription for ${preSelectedTables.length} table${preSelectedTables.length !== 1 ? 's' : ''}`);
        }
      }
    }
  }, [router.query.tables]);

  const loadTables = async () => {
    try {
      const res = await fetch('/api/tables/all');
      const data = await res.json();
      const tables = (data.tables || []).map((t: any) => t.table || t.tableName).filter(Boolean);
      setAllTables(tables);
      setLoading(false);
    } catch (err: any) {
      console.error('Error loading tables:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  const loadConnectionStrings = async () => {
    try {
      const res = await fetch('/api/config/connections');
      const data = await res.json();
      if (data.sourceDbConnection) {
        setDefaultSourceConnection(data.sourceDbConnection);
        setSourceDbConnection(data.sourceDbConnection);
      }
      if (data.targetDbConnection) {
        setDefaultTargetConnection(data.targetDbConnection);
        setTargetDbConnection(data.targetDbConnection);
      }
    } catch (err) {
      // Ignore if endpoint doesn't exist
    }
  };

  const toggleTable = (table: string) => {
    setSelectedTables(prev =>
      prev.includes(table)
        ? prev.filter(t => t !== table)
        : [...prev, table]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreating(true);

    // Use defaults if not using custom connections and fields are empty
    const finalSourceConnection = useCustomConnections 
      ? sourceDbConnection 
      : (sourceDbConnection || defaultSourceConnection);
    const finalTargetConnection = useCustomConnections 
      ? targetDbConnection 
      : (targetDbConnection || defaultTargetConnection);

    // Validate connection strings
    if (!finalSourceConnection || finalSourceConnection.trim() === '') {
      setError('Source database connection string is required. Please set SOURCE_DATABASE_URL environment variable or provide a custom connection string.');
      setCreating(false);
      return;
    }

    if (!finalTargetConnection || finalTargetConnection.trim() === '') {
      setError('Target database connection string is required. Please set TARGET_DATABASE_URL environment variable or provide a custom connection string.');
      setCreating(false);
      return;
    }

    try {
      const res = await fetch('/api/subscriptions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          sourceDbConnection: finalSourceConnection,
          targetDbConnection: finalTargetConnection,
          customTables: selectedTables,
          dataCopy,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        // Show detailed error message if available
        const errorMsg = data.details || data.hint || data.error || 'Failed to create subscription';
        throw new Error(errorMsg);
      }

      // Redirect to subscription details
      router.push(`/subscriptions/${data.id}`);
    } catch (err: any) {
      setError(err.message);
      setCreating(false);
    }
  };

  const filteredTables = allTables.filter(table =>
    table.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
        <Link href="/" className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
          ← Back to Dashboard
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Create New Subscription</h1>
          <p className="mt-2 text-gray-600">
            Create a new replication subscription by selecting tables to replicate
          </p>
        </div>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="text-red-800 font-medium">Error</div>
            <div className="text-red-600 mt-1">{error}</div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Subscription Details */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              1. Subscription Details
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., My Subscription"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Description of this subscription"
                />
              </div>
            </div>
          </div>

          {/* Table Selection */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              2. Select Tables ({selectedTables.length} selected)
            </h2>
            <div className="mb-4">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tables..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="mb-4 flex gap-2">
              <button
                type="button"
                onClick={() => setSelectedTables([...filteredTables])}
                className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                Select All (Filtered)
              </button>
              <button
                type="button"
                onClick={() => setSelectedTables([])}
                className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                Clear All
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-96 overflow-y-auto">
              {filteredTables.map((table) => (
                <label
                  key={table}
                  className="flex items-center p-2 rounded hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedTables.includes(table)}
                    onChange={() => toggleTable(table)}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700 font-mono">{table}</span>
                </label>
              ))}
              {filteredTables.length === 0 && (
                <div className="col-span-full text-center py-8 text-gray-500">
                  {loading ? 'Loading tables...' : 'No tables found'}
                </div>
              )}
            </div>
          </div>

          {/* Connection Strings */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              3. Database Connections
            </h2>
            <div className="mb-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={useCustomConnections}
                  onChange={(e) => {
                    setUseCustomConnections(e.target.checked);
                    if (!e.target.checked) {
                      // Reset to defaults
                      setSourceDbConnection(defaultSourceConnection);
                      setTargetDbConnection(defaultTargetConnection);
                    }
                  }}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">
                  Use custom connection strings (defaults from environment variables)
                </span>
              </label>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Source Database (RDS) Connection String *
                  {!useCustomConnections && defaultSourceConnection && (
                    <span className="text-gray-500 ml-1">(using SOURCE_DATABASE_URL)</span>
                  )}
                </label>
                <input
                  type="password"
                  value={sourceDbConnection}
                  onChange={(e) => setSourceDbConnection(e.target.value)}
                  required
                  disabled={!useCustomConnections && !!defaultSourceConnection}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
                  placeholder={defaultSourceConnection ? "Using SOURCE_DATABASE_URL from environment" : "postgresql://user:password@host:port/database"}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {!useCustomConnections && defaultSourceConnection
                    ? 'Using default connection from environment variables'
                    : 'Password will be hidden for security'}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Target Database (Cloud SQL) Connection String *
                  {!useCustomConnections && defaultTargetConnection && (
                    <span className="text-gray-500 ml-1">(using TARGET_DATABASE_URL)</span>
                  )}
                </label>
                <input
                  type="password"
                  value={targetDbConnection}
                  onChange={(e) => setTargetDbConnection(e.target.value)}
                  required
                  disabled={!useCustomConnections && !!defaultTargetConnection}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
                  placeholder={defaultTargetConnection ? "Using TARGET_DATABASE_URL from environment" : "postgresql://user:password@host:port/database"}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {!useCustomConnections && defaultTargetConnection
                    ? 'Using default connection from environment variables'
                    : 'Password will be hidden for security'}
                </p>
              </div>
            </div>
          </div>

          {/* Data Copy Option */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              4. Replication Settings
            </h2>
            <div className="space-y-4">
              <div>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={dataCopy}
                    onChange={(e) => setDataCopy(e.target.checked)}
                    className="mr-2"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Copy existing data (copy_data = true)
                  </span>
                </label>
                <p className="mt-1 text-xs text-gray-500 ml-6">
                  When enabled, PostgreSQL will copy existing data from the source to the target during subscription creation.
                  When disabled (default), only new changes will be replicated.
                </p>
                <div className="mt-2 ml-6">
                  <span className={`inline-block px-2 py-1 text-xs rounded ${
                    dataCopy 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-gray-100 text-gray-800'
                  }`}>
                    data_copy = {dataCopy ? 'true' : 'false'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-4">
            <Link
              href="/"
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={creating || selectedTables.length === 0 || !name}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating...' : 'Create Subscription'}
            </button>
          </div>
        </form>
        </div>
      </div>
    </>
  );
}

