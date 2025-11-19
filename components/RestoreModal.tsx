import { useState, useEffect } from 'react';

interface BackupInfo {
  filename: string;
  filepath: string;
  size: number;
  created: string;
  modified: string;
}

interface RestoreModalProps {
  isOpen: boolean;
  onClose: () => void;
  backups: BackupInfo[];
  loading: boolean;
  onRestore: (filename: string, cleanRestore?: boolean, tables?: string[]) => void;
  restoring: { [key: string]: boolean };
  formatBytes: (bytes: number) => string;
}

// Helper function to safely parse and display database connection info
function parseDbConnectionInfo(connectionString: string): { host: string; database: string; user: string; display: string } | null {
  try {
    const url = new URL(connectionString);
    const host = url.hostname;
    const port = url.port || '5432';
    const database = url.pathname.slice(1).split('?')[0];
    const user = decodeURIComponent(url.username || '');
    
    return {
      host,
      database,
      user,
      display: `${user}@${host}:${port}/${database}`,
    };
  } catch {
    // Try parsing as space-separated key=value format
    try {
      const params: any = {};
      connectionString.split(' ').forEach(param => {
        const [key, value] = param.split('=');
        if (key && value) {
          params[key] = value;
        }
      });
      
      const host = params.host || params.hostname || '';
      const port = params.port || '5432';
      const database = params.database || params.dbname || '';
      const user = params.user || params.userid || '';
      
      if (host && database && user) {
        return {
          host,
          database,
          user,
          display: `${user}@${host}:${port}/${database}`,
        };
      }
    } catch {}
  }
  return null;
}

export default function RestoreModal({
  isOpen,
  onClose,
  backups,
  loading,
  onRestore,
  restoring,
  formatBytes,
}: RestoreModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [cleanRestore, setCleanRestore] = useState(false);
  const [targetDbInfo, setTargetDbInfo] = useState<{ host: string; database: string; user: string; display: string } | null>(null);
  const [loadingDbInfo, setLoadingDbInfo] = useState(false);
  
  // Table selection state
  const [selectedBackup, setSelectedBackup] = useState<BackupInfo | null>(null);
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [loadingTables, setLoadingTables] = useState(false);
  const [restoreMode, setRestoreMode] = useState<'all' | 'selected'>('all');
  const [error, setError] = useState<string | null>(null);

  const filteredBackups = backups.filter(backup =>
    backup.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Load tables from backup file
  const loadTables = async (backup: BackupInfo) => {
    setLoadingTables(true);
    try {
      const res = await fetch('/api/backup/list-tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: backup.filename }),
      });
      const data = await res.json();
      if (res.ok && data.tables) {
        setAvailableTables(data.tables);
        setSelectedTables(new Set(data.tables)); // Select all by default
      } else {
        setAvailableTables([]);
        setError('Failed to load tables from backup file');
      }
    } catch (err: any) {
      setAvailableTables([]);
      setError('Failed to load tables: ' + err.message);
    } finally {
      setLoadingTables(false);
    }
  };

  const handleBackupSelect = (backup: BackupInfo) => {
    setSelectedBackup(backup);
    setRestoreMode('all');
    setSelectedTables(new Set());
    loadTables(backup);
  };

  const handleTableToggle = (table: string) => {
    const newSelected = new Set(selectedTables);
    if (newSelected.has(table)) {
      newSelected.delete(table);
    } else {
      newSelected.add(table);
    }
    setSelectedTables(newSelected);
  };

  const handleSelectAll = () => {
    setSelectedTables(new Set(availableTables));
  };

  const handleDeselectAll = () => {
    setSelectedTables(new Set());
  };

  // Fetch target database connection info when modal opens
  useEffect(() => {
    if (isOpen && !targetDbInfo && !loadingDbInfo) {
      setLoadingDbInfo(true);
      fetch('/api/config/connections')
        .then(res => res.json())
        .then(data => {
          if (data.targetDbConnection) {
            const info = parseDbConnectionInfo(data.targetDbConnection);
            setTargetDbInfo(info);
          }
        })
        .catch(err => {
          console.error('Failed to fetch target database info:', err);
        })
        .finally(() => {
          setLoadingDbInfo(false);
        });
    }
  }, [isOpen, targetDbInfo, loadingDbInfo]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Restore Backup</h2>
            <p className="text-sm text-gray-600 mt-1">
              Select a backup file to restore to target database
              {targetDbInfo && (
                <span className="ml-2 text-xs font-mono bg-blue-50 px-2 py-0.5 rounded">
                  {targetDbInfo.display}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl font-bold"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          {selectedBackup ? (
            /* Table Selection View */
            <div>
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">Select Tables to Restore</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Backup: <span className="font-mono">{selectedBackup.filename}</span>
                  </p>
                </div>
                <button
                  onClick={() => {
                    setSelectedBackup(null);
                    setAvailableTables([]);
                    setSelectedTables(new Set());
                    setError(null);
                  }}
                  className="text-sm text-gray-600 hover:text-gray-800"
                >
                  ← Back to backups
                </button>
              </div>

              {/* Restore Mode Selection */}
              <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center space-x-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      checked={restoreMode === 'all'}
                      onChange={() => {
                        setRestoreMode('all');
                        setSelectedTables(new Set(availableTables));
                      }}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium">Restore All Tables</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      checked={restoreMode === 'selected'}
                      onChange={() => setRestoreMode('selected')}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium">Restore Selected Tables ({selectedTables.size})</span>
                  </label>
                </div>
              </div>

              {/* Table Selection */}
              {loadingTables ? (
                <div className="text-center py-8 text-gray-500">Loading tables...</div>
              ) : availableTables.length === 0 ? (
                <div className="text-center py-8 text-gray-500">No tables found in backup file</div>
              ) : (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm text-gray-600">
                      {availableTables.length} table{availableTables.length !== 1 ? 's' : ''} available
                    </div>
                    {restoreMode === 'selected' && (
                      <div className="space-x-2">
                        <button
                          onClick={handleSelectAll}
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          Select All
                        </button>
                        <button
                          onClick={handleDeselectAll}
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          Deselect All
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="border border-gray-200 rounded-lg max-h-96 overflow-auto">
                    <div className="p-2 space-y-1">
                      {availableTables.map((table) => (
                        <label
                          key={table}
                          className={`flex items-center p-2 rounded hover:bg-gray-50 cursor-pointer ${
                            restoreMode === 'selected' && !selectedTables.has(table) ? 'opacity-50' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={restoreMode === 'all' || selectedTables.has(table)}
                            onChange={() => handleTableToggle(table)}
                            disabled={restoreMode === 'all'}
                            className="mr-2"
                          />
                          <span className="text-sm font-mono">{table}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end space-x-2">
                    <button
                      onClick={() => {
                        setSelectedBackup(null);
                        setAvailableTables([]);
                        setSelectedTables(new Set());
                        setError(null);
                      }}
                      className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        const tablesToRestore = restoreMode === 'all' 
                          ? undefined 
                          : Array.from(selectedTables);
                        
                        if (restoreMode === 'selected' && tablesToRestore && tablesToRestore.length === 0) {
                          setError('Please select at least one table to restore');
                          return;
                        }

                        const dbInfo = targetDbInfo 
                          ? `\n\nTarget Database: ${targetDbInfo.display}`
                          : '\n\nTarget Database: (using TARGET_DATABASE_URL)';
                        
                        const tableInfo = tablesToRestore 
                          ? `\n\nTables to restore: ${tablesToRestore.length} table(s)\n  ${tablesToRestore.slice(0, 5).join(', ')}${tablesToRestore.length > 5 ? ` ... and ${tablesToRestore.length - 5} more` : ''}`
                          : '\n\nTables to restore: All tables';
                        
                        const warning = cleanRestore
                          ? `⚠️ DESTRUCTIVE OPERATION ⚠️\n\n` +
                            `You are about to restore backup:\n` +
                            `  ${selectedBackup.filename}\n` +
                            `  Size: ${formatBytes(selectedBackup.size)}\n` +
                            `${dbInfo}${tableInfo}\n\n` +
                            `CLEAN RESTORE MODE:\n` +
                            `  • Existing tables will be TRUNCATED (plain SQL) or DROPPED (custom format)\n` +
                            `  • All existing data will be PERMANENTLY DELETED\n` +
                            `  • This action CANNOT be undone\n\n` +
                            `Are you absolutely sure you want to proceed?`
                          : `⚠️ RESTORE OPERATION ⚠️\n\n` +
                            `You are about to restore backup:\n` +
                            `  ${selectedBackup.filename}\n` +
                            `  Size: ${formatBytes(selectedBackup.size)}\n` +
                            `${dbInfo}${tableInfo}\n\n` +
                            `REGULAR RESTORE MODE:\n` +
                            `  • Data will be restored on top of existing tables\n` +
                            `  • This may cause duplicates or conflicts\n` +
                            `  • Consider using "Clean Restore" for a fresh restore\n\n` +
                            `Are you sure you want to proceed?`;
                        
                        if (confirm(warning)) {
                          onRestore(selectedBackup.filename, cleanRestore, tablesToRestore);
                        }
                      }}
                      disabled={restoring[selectedBackup.filename] || (restoreMode === 'selected' && selectedTables.size === 0)}
                      className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                    >
                      {restoring[selectedBackup.filename] ? 'Restoring...' : 'Restore'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Backup List View */
            <>
          {/* Options */}
          <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="flex items-start">
              <input
                type="checkbox"
                id="cleanRestore"
                checked={cleanRestore}
                onChange={(e) => setCleanRestore(e.target.checked)}
                className="mt-1 mr-3 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <div className="flex-1">
                <label htmlFor="cleanRestore" className="text-sm font-medium text-gray-900 cursor-pointer">
                  Clean Restore (Truncate/Drop existing data)
                </label>
                <p className="text-xs text-gray-600 mt-1">
                  {cleanRestore ? (
                    <>
                      <strong>Enabled:</strong> Existing tables will be truncated (plain SQL) or dropped (custom format) before restore.
                      This ensures a clean restore with no duplicate data.
                    </>
                  ) : (
                    <>
                      <strong>Disabled:</strong> Data will be restored on top of existing data. This may cause conflicts or duplicates.
                      Enable this for a clean restore.
                    </>
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Search */}
          <div className="mb-4">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search backups..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Backups Table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Filename</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Size</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Created</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-700 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {loading ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                        Loading backups...
                      </td>
                    </tr>
                  ) : filteredBackups.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                        No backups found
                      </td>
                    </tr>
                  ) : (
                    filteredBackups.map((backup) => (
                      <tr key={backup.filename} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <span className="text-sm font-mono text-gray-900">{backup.filename}</span>
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-600">
                          {formatBytes(backup.size)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {new Date(backup.created).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => handleBackupSelect(backup)}
                            disabled={restoring[backup.filename]}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                          >
                            {restoring[backup.filename] ? 'Restoring...' : 'Select Tables'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <div className="text-sm text-gray-600">
            {filteredBackups.length} backup{filteredBackups.length !== 1 ? 's' : ''} available
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

