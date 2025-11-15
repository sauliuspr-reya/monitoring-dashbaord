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
  onRestore: (filename: string, cleanRestore?: boolean) => void;
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

  const filteredBackups = backups.filter(backup =>
    backup.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
                            onClick={() => {
                              // Build detailed confirmation message
                              const dbInfo = targetDbInfo 
                                ? `\n\nTarget Database: ${targetDbInfo.display}`
                                : '\n\nTarget Database: (using TARGET_DATABASE_URL)';
                              
                              const warning = cleanRestore
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
                              
                              if (confirm(warning)) {
                                onRestore(backup.filename, cleanRestore);
                              }
                            }}
                            disabled={restoring[backup.filename]}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                          >
                            {restoring[backup.filename] ? 'Restoring...' : 'Restore'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
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

