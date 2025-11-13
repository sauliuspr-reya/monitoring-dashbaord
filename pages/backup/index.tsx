import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Navbar from '@/components/Navbar';
import Link from 'next/link';

interface TableInfo {
  tableName: string; // Full name: schema.table
  schema: string;
  table: string; // Just the table name
  sourceRowCount: number;
  sourceSize: number;
}

interface BackupInfo {
  filename: string;
  filepath: string;
  size: number;
  created: string;
  modified: string;
}

export default function BackupPage() {
  const router = useRouter();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingBackups, setLoadingBackups] = useState(true);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [schemaOnly, setSchemaOnly] = useState(false); // Default: include data (schemaOnly = false)
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState<{ [key: string]: boolean }>({});
  const [connectionString, setConnectionString] = useState('');
  const [targetConnectionString, setTargetConnectionString] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadTables();
    loadBackups();
    loadConnectionStrings();
  }, []);

  useEffect(() => {
    // Pre-select tables from query parameter when navigating from tables page
    if (router.query.tables) {
      const preSelectedTables = (router.query.tables as string).split(',').filter(Boolean);
      if (preSelectedTables.length > 0) {
        setSelectedTables(new Set(preSelectedTables));
      }
    }
  }, [router.query.tables]);

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

  const loadConnectionStrings = async () => {
    try {
      const res = await fetch('/api/config/connections');
      if (res.ok) {
        const data = await res.json();
        if (data.sourceDbConnection) setConnectionString(data.sourceDbConnection);
        if (data.targetDbConnection) setTargetConnectionString(data.targetDbConnection);
      }
    } catch (err) {
      // Ignore
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

  const selectAllFiltered = () => {
    const filtered = filteredTables.map(t => t.table);
    setSelectedTables(new Set(filtered));
  };

  const deselectAll = () => {
    setSelectedTables(new Set());
  };

  const handleBackup = async () => {
    if (selectedTables.size === 0) {
      setError('Please select at least one table');
      return;
    }

    if (!connectionString) {
      setError('Source connection string is required');
      return;
    }

    try {
      setBackingUp(true);
      setError(null);
      setSuccess(null);

      // Convert selected table names to full tableName (schema.table) format
      const tablesToBackup = Array.from(selectedTables).map(selectedTable => {
        // Find the full table info to get schema.table format
        const tableInfo = tables.find(t => t.table === selectedTable || t.tableName === selectedTable);
        if (tableInfo && tableInfo.tableName) {
          return tableInfo.tableName; // Use full schema.table format
        }
        // Fallback: if table name already has schema, use it; otherwise assume public schema
        return selectedTable.includes('.') ? selectedTable : `public.${selectedTable}`;
      });

      const res = await fetch('/api/backup/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tables: tablesToBackup,
          connectionString,
          schemaOnly, // false = include data, true = schema only
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(`Backup created: ${data.filename} (${formatBytes(data.fileSize)})`);
        await loadBackups();
      } else {
        setError(data.error || 'Failed to create backup');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create backup');
    } finally {
      setBackingUp(false);
    }
  };

  const handleRestore = async (filename: string) => {
    if (!targetConnectionString) {
      setError('Target connection string is required');
      return;
    }

    if (!confirm(`Restore backup ${filename} to target database? This will overwrite existing tables.`)) {
      return;
    }

    try {
      setRestoring(prev => ({ ...prev, [filename]: true }));
      setError(null);
      setSuccess(null);

      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename,
          connectionString: targetConnectionString,
          dryRun: false,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(`Restore completed: ${filename}`);
        await loadBackups();
      } else {
        setError(data.error || 'Failed to restore backup');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to restore backup');
    } finally {
      setRestoring(prev => ({ ...prev, [filename]: false }));
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const filteredTables = tables.filter(table =>
    table.table.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-6 sm:px-8 lg:px-12 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Backup & Restore</h1>
            <p className="mt-2 text-gray-600">
              Backup tables using pg_dump and restore them to target databases
            </p>
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

          {/* Connection Strings */}
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Database Connections</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Source Database (for backup) *
                </label>
                <input
                  type="password"
                  value={connectionString}
                  onChange={(e) => setConnectionString(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                  placeholder="postgresql://user:password@host:port/database"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Target Database (for restore) *
                </label>
                <input
                  type="password"
                  value={targetConnectionString}
                  onChange={(e) => setTargetConnectionString(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                  placeholder="postgresql://user:password@host:port/database"
                />
              </div>
            </div>
          </div>

          {/* Backup Section */}
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Backup Tables ({selectedTables.size} selected)
            </h2>

            <div className="mb-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={schemaOnly}
                  onChange={(e) => setSchemaOnly(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700">Schema only (exclude data)</span>
              </label>
              <p className="ml-6 mt-1 text-xs text-gray-500">
                By default, backups include both schema and data. Check this to backup schema only.
              </p>
            </div>

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
                onClick={selectAllFiltered}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                Select All (Filtered)
              </button>
              {selectedTables.size > 0 && (
                <button
                  onClick={deselectAll}
                  className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                >
                  Deselect All
                </button>
              )}
            </div>

            <div className="mb-4 max-h-64 overflow-y-auto border border-gray-200 rounded p-2">
              {loading ? (
                <div className="text-center py-8 text-gray-500">Loading tables...</div>
              ) : filteredTables.length === 0 ? (
                <div className="text-center py-8 text-gray-500">No tables found</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {filteredTables.map((table) => (
                    <label
                      key={table.tableName}
                      className="flex items-center p-2 rounded hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedTables.has(table.table)}
                        onChange={() => toggleTable(table.table)}
                        className="mr-2"
                      />
                      <span className="text-sm text-gray-700 font-mono">{table.table}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={handleBackup}
              disabled={backingUp || selectedTables.size === 0 || !connectionString}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {backingUp ? 'Creating Backup...' : `Backup ${selectedTables.size} Table${selectedTables.size !== 1 ? 's' : ''}`}
            </button>
          </div>

          {/* Restore Section */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Available Backups</h2>

            {loadingBackups ? (
              <div className="text-center py-8 text-gray-500">Loading backups...</div>
            ) : backups.length === 0 ? (
              <div className="text-center py-8 text-gray-500">No backups found</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Filename</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Size</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {backups.map((backup) => (
                      <tr key={backup.filename} className="hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-900">
                          {backup.filename}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-600">
                          {formatBytes(backup.size)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                          {new Date(backup.created).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-center">
                          <button
                            onClick={() => handleRestore(backup.filename)}
                            disabled={restoring[backup.filename] || !targetConnectionString}
                            className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                          >
                            {restoring[backup.filename] ? 'Restoring...' : 'Restore'}
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
      </div>
    </>
  );
}


