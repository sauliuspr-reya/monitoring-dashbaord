import { useState } from 'react';

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
  onRestore: (filename: string) => void;
  restoring: { [key: string]: boolean };
  formatBytes: (bytes: number) => string;
}

export default function CompletedBackupsList({
  backups,
  loading,
  onRestore,
  restoring,
  formatBytes,
}: CompletedBackupsListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'healthy' | 'failed'>('all');

  // Separate backups into healthy and failed/missing
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

        {/* Search */}
        <div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search backup files..."
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>
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
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Filename
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Size
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Tables
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Created
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
                  className={`hover:bg-gray-50 ${backup.exists === false ? 'bg-orange-50' : ''}`}
                >
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
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-600">
                    {backup.size > 0 ? formatBytes(backup.size) : '—'}
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
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {new Date(backup.created).toLocaleString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <button
                      onClick={() => {
                        if (backup.exists === false) {
                          alert(`Warning: The backup file ${backup.filename} is not found on the filesystem. The restore may fail.`);
                        }
                        if (confirm(`Restore backup ${backup.filename}? This will overwrite existing tables.`)) {
                          onRestore(backup.filename);
                        }
                      }}
                      disabled={restoring[backup.filename] || backup.exists === false}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                      title={backup.exists === false ? 'File not found on filesystem' : ''}
                    >
                      {restoring[backup.filename] ? 'Restoring...' : 'Restore'}
                    </button>
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

