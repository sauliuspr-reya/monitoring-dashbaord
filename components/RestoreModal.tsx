import { useState } from 'react';

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
  onRestore: (filename: string) => void;
  restoring: { [key: string]: boolean };
  formatBytes: (bytes: number) => string;
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

  const filteredBackups = backups.filter(backup =>
    backup.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
                              if (confirm(`Restore backup ${backup.filename}? This will overwrite existing tables.`)) {
                                onRestore(backup.filename);
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

