import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Navbar from '@/components/Navbar';

interface Publication {
  name: string;
  allTables: boolean;
  insertEnabled: boolean;
  updateEnabled: boolean;
  deleteEnabled: boolean;
  truncateEnabled: boolean;
  tables: string[];
  tableCount: number;
  subscriptions?: string[]; // Subscriptions using this publication
}

export default function PublicationsPage() {
  const router = useRouter();
  const [publications, setPublications] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);

  // Create form state
  const [pubName, setPubName] = useState('');
  const [allTables, setAllTables] = useState(false);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadPublications();
    loadAvailableTables();
  }, []);

  const loadPublications = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/publications/list');
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to load publications');
      }
      const data = await res.json();
      
      // Also get subscriptions that use each publication
      const publicationsWithSubs = await Promise.all(
        data.publications.map(async (pub: Publication) => {
          try {
            const subsRes = await fetch('/api/groups');
            if (subsRes.ok) {
              const subsData = await subsRes.json();
              // subsData is an array of subscriptions
              const subscriptions = (Array.isArray(subsData) ? subsData : (subsData.subscriptions || [])).filter(
                (sub: any) => sub.publicationName === pub.name || sub.publication_name === pub.name
              ).map((sub: any) => sub.name);
              return { ...pub, subscriptions };
            }
          } catch (err) {
            console.warn('Failed to load subscriptions for publication:', err);
          }
          return { ...pub, subscriptions: [] };
        })
      );
      
      setPublications(publicationsWithSubs);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadAvailableTables = async () => {
    try {
      const res = await fetch('/api/tables/all');
      if (res.ok) {
        const data = await res.json();
        const tables = (data.tables || []).map((t: any) => t.tableName || t.table).filter(Boolean);
        setAvailableTables(tables);
      }
    } catch (err) {
      console.error('Error loading tables:', err);
    }
  };

  const handleCreatePublication = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pubName.trim()) {
      setError('Publication name is required');
      return;
    }

    if (!allTables && selectedTables.length === 0) {
      setError('Please select at least one table or enable "All Tables"');
      return;
    }

    try {
      setCreating(true);
      setError(null);

      const res = await fetch('/api/publications/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: pubName.trim(),
          allTables,
          tables: allTables ? undefined : selectedTables,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || data.details || 'Failed to create publication');
      }

      // Reset form
      setPubName('');
      setAllTables(false);
      setSelectedTables([]);
      setShowCreateForm(false);

      // Reload publications
      await loadPublications();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const toggleTable = (table: string) => {
    setSelectedTables(prev =>
      prev.includes(table)
        ? prev.filter(t => t !== table)
        : [...prev, table]
    );
  };

  const filteredTables = availableTables.filter(table =>
    table.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-gray-600">Loading publications...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8 flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Publications</h1>
              <p className="mt-2 text-gray-600">
                Manage PostgreSQL publications on the source database
              </p>
            </div>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              {showCreateForm ? 'Cancel' : 'Create Publication'}
            </button>
          </div>

          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="text-red-800 font-medium">Error</div>
              <div className="text-red-600 mt-1">{error}</div>
            </div>
          )}

          {/* Create Publication Form */}
          {showCreateForm && (
            <div className="mb-8 bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Create New Publication</h2>
              <form onSubmit={handleCreatePublication} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Publication Name *
                  </label>
                  <input
                    type="text"
                    value={pubName}
                    onChange={(e) => setPubName(e.target.value)}
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g., my_publication"
                  />
                </div>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={allTables}
                      onChange={(e) => {
                        setAllTables(e.target.checked);
                        if (e.target.checked) {
                          setSelectedTables([]);
                        }
                      }}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      Publish all tables
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500 ml-6">
                    When enabled, all current and future tables will be included in this publication.
                  </p>
                </div>

                {!allTables && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Select Tables ({selectedTables.length} selected)
                    </label>
                    <div className="mb-2">
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search tables..."
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div className="mb-2 flex gap-2">
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
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-64 overflow-y-auto border border-gray-200 rounded p-2">
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
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-4">
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateForm(false);
                      setPubName('');
                      setAllTables(false);
                      setSelectedTables([]);
                      setError(null);
                    }}
                    className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !pubName.trim() || (!allTables && selectedTables.length === 0)}
                    className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                  >
                    {creating ? 'Creating...' : 'Create Publication'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Publications List */}
          {publications.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-8 text-center">
              <p className="text-gray-600">No publications found</p>
              <p className="text-sm text-gray-500 mt-2">
                Create a publication to start replicating tables
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Publication Name
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Tables
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Subscriptions
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Operations
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {publications.map((pub) => (
                    <tr key={pub.name} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-gray-900 font-mono">
                            {pub.name}
                          </span>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {pub.insertEnabled && (
                              <span className="px-2 py-0.5 text-xs bg-green-100 text-green-800 rounded">INSERT</span>
                            )}
                            {pub.updateEnabled && (
                              <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-800 rounded">UPDATE</span>
                            )}
                            {pub.deleteEnabled && (
                              <span className="px-2 py-0.5 text-xs bg-red-100 text-red-800 rounded">DELETE</span>
                            )}
                            {pub.truncateEnabled && (
                              <span className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-800 rounded">TRUNCATE</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-900">
                          {pub.allTables ? (
                            <span className="font-medium text-blue-600">ALL TABLES</span>
                          ) : (
                            <div>
                              <span className="font-medium">{pub.tableCount} table{pub.tableCount !== 1 ? 's' : ''}</span>
                              <details className="mt-2">
                                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                                  View tables
                                </summary>
                                <div className="mt-2 max-h-32 overflow-y-auto">
                                  <ul className="list-disc list-inside text-xs font-mono text-gray-600 space-y-1">
                                    {pub.tables.slice(0, 20).map((table) => (
                                      <li key={table}>{table}</li>
                                    ))}
                                    {pub.tables.length > 20 && (
                                      <li className="text-gray-500">... and {pub.tables.length - 20} more</li>
                                    )}
                                  </ul>
                                </div>
                              </details>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {pub.subscriptions && pub.subscriptions.length > 0 ? (
                          <div className="text-sm">
                            <div className="font-medium text-gray-900">{pub.subscriptions.length} subscription{pub.subscriptions.length !== 1 ? 's' : ''}</div>
                            <div className="mt-1 space-y-1">
                              {pub.subscriptions.map((subName) => (
                                <Link
                                  key={subName}
                                  href={`/subscriptions?search=${encodeURIComponent(subName)}`}
                                  className="block text-xs text-blue-600 hover:text-blue-800 font-mono"
                                >
                                  {subName}
                                </Link>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <span className="text-sm text-gray-500">No subscriptions</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        <button
                          onClick={async () => {
                            if (confirm(`Are you sure you want to drop publication "${pub.name}"? This will affect all subscriptions using it.`)) {
                              try {
                                const res = await fetch(`/api/publications/${encodeURIComponent(pub.name)}/delete`, {
                                  method: 'DELETE',
                                  headers: { 'Content-Type': 'application/json' },
                                });
                                const data = await res.json();
                                if (res.ok) {
                                  await loadPublications();
                                } else {
                                  setError(data.error || data.details || 'Failed to drop publication');
                                }
                              } catch (err: any) {
                                setError(err.message || 'Failed to drop publication');
                              }
                            }
                          }}
                          className="text-red-600 hover:text-red-800"
                        >
                          Drop
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

