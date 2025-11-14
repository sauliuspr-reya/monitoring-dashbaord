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
  const [useExistingPublication, setUseExistingPublication] = useState(false);
  const [existingPublications, setExistingPublications] = useState<Array<{name: string; tables: string[]; tableCount: number}>>([]);
  const [selectedPublications, setSelectedPublications] = useState<string[]>([]); // Support multiple publications
  const [selectedTablesFromPub, setSelectedTablesFromPub] = useState<Set<string>>(new Set()); // Selected tables from publications
  const [loadingPublications, setLoadingPublications] = useState(false);

  useEffect(() => {
    loadTables();
    loadConnectionStrings();
    loadPublications();
  }, []);

  const loadPublications = async () => {
    try {
      setLoadingPublications(true);
      const res = await fetch('/api/publications/list');
      if (res.ok) {
        const data = await res.json();
        setExistingPublications(data.publications || []);
      }
    } catch (err) {
      console.error('Error loading publications:', err);
    } finally {
      setLoadingPublications(false);
    }
  };

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
          customTables: useExistingPublication ? Array.from(selectedTablesFromPub) : selectedTables,
          dataCopy,
          useExistingPublication,
          existingPublicationNames: useExistingPublication ? selectedPublications : undefined,
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

          {/* Publication Selection */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              2. Publication
            </h2>
            <div className="space-y-4">
              <div>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="publicationMode"
                    checked={!useExistingPublication}
                    onChange={() => {
                      setUseExistingPublication(false);
                      setSelectedPublications([]);
                      setSelectedTablesFromPub(new Set());
                    }}
                    className="mr-2"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Create new publication
                  </span>
                </label>
                <p className="text-xs text-gray-500 ml-6 mt-1">
                  A new publication will be created based on your subscription name and selected tables.
                </p>
              </div>
              <div>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="publicationMode"
                    checked={useExistingPublication}
                    onChange={() => setUseExistingPublication(true)}
                    className="mr-2"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Use existing publication
                  </span>
                </label>
                <p className="text-xs text-gray-500 ml-6 mt-1">
                  Select an existing publication that was created previously.
                </p>
              </div>

              {useExistingPublication && (
                <div className="ml-6 mt-4 space-y-4">
                  {loadingPublications ? (
                    <div className="text-sm text-gray-500">Loading publications...</div>
                  ) : existingPublications.length === 0 ? (
                    <div className="text-sm text-gray-500">
                      No publications found. <Link href="/publications" className="text-blue-600 hover:text-blue-800">Create one</Link>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Select Publications (you can select multiple):
                        </label>
                        <div className="space-y-2 max-h-48 overflow-y-auto border border-gray-200 rounded p-2">
                          {existingPublications.map((pub) => (
                            <label
                              key={pub.name}
                              className="flex items-start p-2 rounded hover:bg-gray-50 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={selectedPublications.includes(pub.name)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedPublications([...selectedPublications, pub.name]);
                                    // Auto-select all tables from this publication
                                    const pubTables = pub.tables || [];
                                    setSelectedTablesFromPub(new Set([...selectedTablesFromPub, ...pubTables]));
                                  } else {
                                    setSelectedPublications(selectedPublications.filter(p => p !== pub.name));
                                    // Remove tables from this publication
                                    const pubTables = pub.tables || [];
                                    const newSet = new Set(selectedTablesFromPub);
                                    pubTables.forEach(t => newSet.delete(t));
                                    setSelectedTablesFromPub(newSet);
                                  }
                                }}
                                className="mt-1 mr-2"
                              />
                              <div className="flex-1">
                                <span className="text-sm font-medium text-gray-900 font-mono">{pub.name}</span>
                                <span className="text-xs text-gray-500 ml-2">
                                  ({pub.tableCount} table{pub.tableCount !== 1 ? 's' : ''})
                                </span>
                              </div>
                            </label>
                          ))}
                        </div>
                      </div>

                      {selectedPublications.length > 0 && (
                        <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
                          <div className="text-sm font-medium text-gray-900 mb-3">
                            Select Tables from Selected Publications ({selectedTablesFromPub.size} selected):
                          </div>
                          <div className="mb-2">
                            <input
                              type="text"
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              placeholder="Search tables..."
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                            />
                          </div>
                          <div className="mb-2 flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                // Select all tables from selected publications
                                const allTables = selectedPublications.flatMap(pubName => {
                                  const pub = existingPublications.find(p => p.name === pubName);
                                  return pub?.tables || [];
                                });
                                setSelectedTablesFromPub(new Set(allTables));
                              }}
                              className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                            >
                              Select All
                            </button>
                            <button
                              type="button"
                              onClick={() => setSelectedTablesFromPub(new Set())}
                              className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                            >
                              Clear All
                            </button>
                          </div>
                          <div className="max-h-64 overflow-y-auto border border-gray-200 rounded p-2 bg-white">
                            {selectedPublications.flatMap(pubName => {
                              const pub = existingPublications.find(p => p.name === pubName);
                              if (!pub) return [];
                              const filtered = pub.tables.filter(t => 
                                t.toLowerCase().includes(searchQuery.toLowerCase())
                              );
                              return filtered.map(table => (
                                <label
                                  key={`${pubName}-${table}`}
                                  className="flex items-center p-1 rounded hover:bg-gray-50 cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedTablesFromPub.has(table)}
                                    onChange={(e) => {
                                      const newSet = new Set(selectedTablesFromPub);
                                      if (e.target.checked) {
                                        newSet.add(table);
                                      } else {
                                        newSet.delete(table);
                                      }
                                      setSelectedTablesFromPub(newSet);
                                    }}
                                    className="mr-2"
                                  />
                                  <span className="text-xs font-mono text-gray-700">{table}</span>
                                  <span className="text-xs text-gray-400 ml-2">({pubName})</span>
                                </label>
                              ));
                            })}
                            {selectedPublications.flatMap(pubName => {
                              const pub = existingPublications.find(p => p.name === pubName);
                              return pub?.tables || [];
                            }).filter(t => t.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 && (
                              <div className="text-center py-4 text-gray-500 text-sm">No tables found</div>
                            )}
                          </div>
                          <p className="mt-2 text-xs text-gray-500">
                            You can select a subset of tables from the selected publications. Only selected tables will be replicated.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Table Selection - Only show if creating new publication */}
          {!useExistingPublication && (
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">
                3. Select Tables ({selectedTables.length} selected)
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
          )}

          {/* Connection Strings */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              {useExistingPublication ? '3. Database Connections' : '4. Database Connections'}
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
              {useExistingPublication ? '4. Replication Settings' : '5. Replication Settings'}
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
              disabled={creating || (!useExistingPublication && selectedTables.length === 0) || (useExistingPublication && (selectedPublications.length === 0 || selectedTablesFromPub.size === 0)) || !name}
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

