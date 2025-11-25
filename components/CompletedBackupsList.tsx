import { useState, useEffect } from 'react';

interface BackupInfo {
  filename: string;
  filepath: string;
  size: number;
  created: string;
  modified: string;
  exists?: boolean;
  taskId?: string;
  tables?: string[];
}

interface CompletedBackupsListProps {
  backups: BackupInfo[];
  loading: boolean;
  onRestore: (filename: string, cleanRestore?: boolean) => void;
  onDelete?: (filename: string) => Promise<void>;
  onBulkDelete?: (filenames: string[]) => Promise<void>;
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

export default function CompletedBackupsList({
  backups,
  loading,
  onRestore,
  onDelete,
  onBulkDelete,
  restoring,
  formatBytes,
}: CompletedBackupsListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'healthy' | 'failed'>('all');
  const [targetDbInfo, setTargetDbInfo] = useState<{ host: string; database: string; user: string; display: string } | null>(null);
  const [cleanRestore, setCleanRestore] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Fetch target database connection info
  useEffect(() => {
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
      });
  }, []); // Fetch once on mount

  const healthyBackups = backups.filter(b => b.exists !== false && b.size > 0);
  const failedBackups = backups.filter(b => b.exists === false || b.size === 0);

  const getFilteredBackups = () => {
    let toFilter = backups;
    if (activeTab === 'healthy') {
      toFilter = healthyBackups;
    } else if (activeTab === 'failed') {
      toFilter = failedBackups;
    }
    return toFilter.filter(backup =>
      backup.filename.toLowerCase().includes(searchQuery.toLowerCase())
    );
  };

  const filteredBackups = getFilteredBackups();

  const toggleSelect = (filename: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedFiles.size === filteredBackups.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(filteredBackups.map(b => b.filename)));
    }
  };

  const handleDelete = async (filename: string) => {
    if (!onDelete) return;
    if (!confirm(`Delete backup file "${filename}"? This cannot be undone.`)) return;
    
    setDeleting(filename);
    try {
      await onDelete(filename);
      selectedFiles.delete(filename);
      setSelectedFiles(new Set(selectedFiles));
    } finally {
      setDeleting(null);
    }
  };

  const handleBulkDelete = async () => {
    if (!onBulkDelete || selectedFiles.size === 0) return;
    
    const count = selectedFiles.size;
    if (!confirm(`Delete ${count} backup file(s)? This cannot be undone.`)) return;
    
    setBulkDeleting(true);
    try {
      await onBulkDelete(Array.from(selectedFiles));
      setSelectedFiles(new Set());
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Completed Backups</h3>
            <p className="text-sm text-gray-600 mt-1">
              Backup files available for restore
            </p>
          </div>
          <div className="text-sm text-gray-500">
            {backups.length} file{backups.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-4 border-b border-gray-200">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('all')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'all'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              All Backups
              <span className="ml-2 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                {backups.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('healthy')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'healthy'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Healthy
              <span className="ml-2 text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full">
                {healthyBackups.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('failed')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'failed'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Failed/Missing
              <span className="ml-2 text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full">
                {failedBackups.length}
              </span>
            </button>
          </nav>
        </div>

        {/* Clean Restore Option */}
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-start">
            <input
              type="checkbox"
              id="cleanRestoreCompleted"
              checked={cleanRestore}
              onChange={(e) => setCleanRestore(e.target.checked)}
              className="mt-1 mr-3 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <div className="flex-1">
              <label htmlFor="cleanRestoreCompleted" className="text-sm font-medium text-gray-900 cursor-pointer">
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
                  </>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search backup files..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>

        {/* Bulk Actions */}
        {selectedFiles.size > 0 && onBulkDelete && (
          <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-blue-800">{selectedFiles.size} file(s) selected</span>
              <button
                onClick={() => setSelectedFiles(new Set())}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Clear
              </button>
            </div>
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {bulkDeleting ? 'Deleting...' : `Delete ${selectedFiles.size} File(s)`}
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        {loading ? (
          <div className="p-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-500">Loading backups...</p>
          </div>
        ) : filteredBackups.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            {searchQuery ? 'No backups match your search' : 'No backup files found'}
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {(onDelete || onBulkDelete) && (
                  <th className="px-3 py-3 text-center w-10">
                    <input
                      type="checkbox"
                      checked={selectedFiles.size > 0 && selectedFiles.size === filteredBackups.length}
                      onChange={toggleSelectAll}
                      className="rounded w-4 h-4"
                    />
                  </th>
                )}
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Filename
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Task ID
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Size
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Tables
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredBackups.map((backup) => (
                <tr 
                  key={backup.filename} 
                  className={`hover:bg-gray-50 ${backup.exists === false ? 'bg-orange-50' : ''} ${selectedFiles.has(backup.filename) ? 'bg-blue-50' : ''}`}
                >
                  {(onDelete || onBulkDelete) && (
                    <td className="px-3 py-4 text-center">
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(backup.filename)}
                        onChange={() => toggleSelect(backup.filename)}
                        className="rounded w-4 h-4"
                      />
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center space-x-2">
                      <span className="text-sm font-mono text-gray-900">{backup.filename}</span>
                      {backup.exists === false && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-800 rounded" title="File not found on filesystem">
                          ⚠ Missing
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {backup.taskId ? (
                      <a
                        href={`/backup?taskId=${backup.taskId}`}
                        className="text-blue-600 hover:text-blue-800 hover:underline font-mono text-xs"
                        title={`View task ${backup.taskId}`}
                      >
                        {backup.taskId.slice(0, 8)}...
                      </a>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-600">
                    {backup.size > 0 ? formatBytes(backup.size) : '—'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {backup.created ? (
                      <div>
                        <div>{new Date(backup.created).toLocaleDateString()}</div>
                        <div className="text-xs text-gray-500">{new Date(backup.created).toLocaleTimeString()}</div>
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {backup.tables && backup.tables.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {backup.tables.slice(0, 3).map((t, idx) => (
                          <span key={idx} className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">
                            {t.replace(/^public\./, '').replace(/^"/, '').replace(/"$/, '')}
                          </span>
                        ))}
                        {backup.tables.length > 3 && (
                          <span className="text-xs text-gray-500">+{backup.tables.length - 3}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => {
                          if (backup.exists === false) {
                            alert(`Warning: The backup file ${backup.filename} is not found on the filesystem. The restore may fail.`);
                          }
                          
                          // Build detailed confirmation message
                          const dbInfo = targetDbInfo 
                            ? `\n\nTarget Database: ${targetDbInfo.display}`
                            : '\n\nTarget Database: (using TARGET_DATABASE_URL)';
                          
                          const confirmMsg = cleanRestore
                            ? `⚠️ DESTRUCTIVE OPERATION ⚠️\n\n` +
                              `You are about to restore backup:\n` +
                              `  ${backup.filename}\n` +
                              `  Size: ${formatBytes(backup.size)}\n` +
                              `${dbInfo}\n\n` +
                              `CLEAN RESTORE MODE:\n` +
                              `  • Existing tables will be TRUNCATED (plain SQL) or DROPPED (custom format)\n` +
                              `  • All existing data will be PERMANENTLY DELETED\n` +
                              `  • This action CANNOT be undone\n\n` +
                              `Are you absolutely sure you want to proceed?`
                            : `⚠️ RESTORE OPERATION ⚠️\n\n` +
                              `You are about to restore backup:\n` +
                              `  ${backup.filename}\n` +
                              `  Size: ${formatBytes(backup.size)}\n` +
                              `${dbInfo}\n\n` +
                              `REGULAR RESTORE MODE:\n` +
                              `  • Data will be restored on top of existing tables\n` +
                              `  • This may cause duplicates or conflicts\n` +
                              `  • Consider using "Clean Restore" for a fresh restore\n\n` +
                              `Are you sure you want to proceed?`;
                          
                          if (confirm(confirmMsg)) {
                            onRestore(backup.filename, cleanRestore);
                          }
                        }}
                        disabled={restoring[backup.filename] || backup.exists === false}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                        title={backup.exists === false ? 'File not found on filesystem' : ''}
                      >
                        {restoring[backup.filename] ? 'Restoring...' : 'Restore'}
                      </button>
                      {onDelete && (
                        <button
                          onClick={() => handleDelete(backup.filename)}
                          disabled={deleting === backup.filename}
                          className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-300 rounded hover:bg-red-50 disabled:opacity-50"
                        >
                          {deleting === backup.filename ? '...' : 'Delete'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

