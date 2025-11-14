import { useState } from 'react';

interface TableInfo {
  tableName: string;
  schema: string;
  table: string;
  sourceRowCount: number;
  sourceSize: number;
  services?: string[];
  writersOnSource?: string[];
  writersOnTarget?: string[];
  rateOfChange1Hour?: number | null;
  rateOfChange24Hour?: number | null;
  loading?: boolean;
}

interface BackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  tables: TableInfo[];
  loading: boolean;
  onBackup: (options: {
    tables?: string[];
    excludeTables?: string[];
    schemaOnly: boolean;
    enableReplication: boolean;
  }) => void;
  backingUp: boolean;
}

export default function BackupModal({
  isOpen,
  onClose,
  tables,
  loading,
  onBackup,
  backingUp,
}: BackupModalProps) {
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [excludeMode, setExcludeMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [enableReplication, setEnableReplication] = useState(true);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const formatRateOfChange = (rate: number | null | undefined) => {
    if (rate === null || rate === undefined) return '—';
    if (Math.abs(rate) < 0.01) return '~0';
    const absRate = Math.abs(rate);
    const sign = rate > 0 ? '+' : '';
    if (absRate < 1) return `${sign}${rate.toFixed(2)}/min`;
    if (absRate < 60) return `${sign}${Math.round(rate)}/min`;
    const perHour = rate * 60;
    if (perHour < 1000) return `${sign}${Math.round(perHour)}/hr`;
    return `${sign}${(perHour / 1000).toFixed(1)}k/hr`;
  };

  const formatNumber = (num: number) => {
    if (num < 1000) return num.toString();
    if (num < 1000000) return `${(num / 1000).toFixed(1)}k`;
    return `${(num / 1000000).toFixed(1)}M`;
  };

  const filteredTables = tables.filter(table =>
    table.table.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
    setSelectedTables(new Set(filteredTables.map(t => t.table)));
  };

  const deselectAll = () => {
    setSelectedTables(new Set());
  };

  const handleSubmit = () => {
    if (!excludeMode && selectedTables.size === 0) {
      alert('Please select at least one table to include');
      return;
    }
    if (excludeMode && selectedTables.size === 0) {
      alert('Please select at least one table to exclude');
      return;
    }

    onBackup({
      tables: !excludeMode ? Array.from(selectedTables) : undefined,
      excludeTables: excludeMode ? Array.from(selectedTables) : undefined,
      schemaOnly,
      enableReplication: !schemaOnly && enableReplication,
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-7xl h-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Create Backup</h2>
            <p className="text-sm text-gray-600 mt-1">
              Select tables to backup ({selectedTables.size} {excludeMode ? 'excluded' : 'selected'})
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
          {/* Mode Toggle */}
          <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={excludeMode}
                onChange={(e) => setExcludeMode(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm font-medium text-gray-700">
                Exclude mode (backup all tables except selected)
              </span>
            </label>
          </div>

          {/* Backup Type */}
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Backup Type</h3>
            <div className="space-y-3">
              <label className="flex items-start">
                <input
                  type="radio"
                  name="backupType"
                  checked={schemaOnly}
                  onChange={() => {
                    setSchemaOnly(true);
                    setEnableReplication(false);
                  }}
                  className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div className="ml-3">
                  <span className="text-sm font-medium text-gray-700">Schema Only</span>
                  <p className="text-xs text-gray-500 mt-1">Table structures only (no data)</p>
                </div>
              </label>
              <label className="flex items-start">
                <input
                  type="radio"
                  name="backupType"
                  checked={!schemaOnly}
                  onChange={() => setSchemaOnly(false)}
                  className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div className="ml-3 flex-1">
                  <span className="text-sm font-medium text-gray-700">Full Backup (Data + Schema)</span>
                  <p className="text-xs text-gray-500 mt-1">Backup both structures and data</p>
                </div>
              </label>
            </div>
            {!schemaOnly && (
              <div className="mt-4 pt-4 border-t border-blue-200">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={enableReplication}
                    onChange={(e) => setEnableReplication(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm font-medium text-gray-700">
                    Enable Replication Snapshot
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* Search */}
          <div className="mb-4">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tables..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Table Selection Controls */}
          <div className="mb-3 flex gap-2">
            <button
              onClick={selectAll}
              className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
            >
              Select All
            </button>
            {selectedTables.size > 0 && (
              <button
                onClick={deselectAll}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
              >
                Deselect All
              </button>
            )}
            <div className="flex-1"></div>
            <span className="text-xs text-gray-500 self-center">
              {filteredTables.length} table{filteredTables.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Tables Table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto max-h-96">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 w-12">
                      <input
                        type="checkbox"
                        checked={filteredTables.length > 0 && filteredTables.every(t => selectedTables.has(t.table))}
                        onChange={(e) => {
                          if (e.target.checked) {
                            selectAll();
                          } else {
                            deselectAll();
                          }
                        }}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Table</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Rows</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Size</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Writers</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Change Rate</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                        Loading tables...
                      </td>
                    </tr>
                  ) : filteredTables.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                        No tables found
                      </td>
                    </tr>
                  ) : (
                    filteredTables.map((table) => (
                      <tr
                        key={table.tableName}
                        className={`hover:bg-gray-50 cursor-pointer ${
                          selectedTables.has(table.table) ? 'bg-blue-50' : ''
                        }`}
                        onClick={() => toggleTable(table.table)}
                      >
                        <td className="px-4 py-2">
                          <input
                            type="checkbox"
                            checked={selectedTables.has(table.table)}
                            onChange={() => toggleTable(table.table)}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <span className="text-sm font-mono text-gray-900">{table.table}</span>
                        </td>
                        <td className="px-4 py-2 text-right text-sm text-gray-600">
                          {table.loading ? (
                            <span className="text-gray-400">...</span>
                          ) : (
                            formatNumber(table.sourceRowCount)
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-sm text-gray-600">
                          {table.loading ? (
                            <span className="text-gray-400">...</span>
                          ) : (
                            formatBytes(table.sourceSize)
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-col gap-1">
                            {table.writersOnSource && table.writersOnSource.length > 0 && (
                              <div className="text-xs">
                                <span className="text-blue-600 font-medium">Source:</span>
                                <span className="ml-1 text-gray-600">
                                  {table.writersOnSource.slice(0, 2).join(', ')}
                                  {table.writersOnSource.length > 2 && ` +${table.writersOnSource.length - 2}`}
                                </span>
                              </div>
                            )}
                            {table.writersOnTarget && table.writersOnTarget.length > 0 && (
                              <div className="text-xs">
                                <span className="text-orange-600 font-medium">Target:</span>
                                <span className="ml-1 text-gray-600">
                                  {table.writersOnTarget.slice(0, 2).join(', ')}
                                  {table.writersOnTarget.length > 2 && ` +${table.writersOnTarget.length - 2}`}
                                </span>
                              </div>
                            )}
                            {(!table.writersOnSource || table.writersOnSource.length === 0) &&
                             (!table.writersOnTarget || table.writersOnTarget.length === 0) && (
                              <span className="text-xs text-gray-400">No writers</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right text-sm text-gray-600">
                          {table.loading ? (
                            <span className="text-gray-400">...</span>
                          ) : (
                            <span className="font-mono text-xs">
                              {formatRateOfChange(table.rateOfChange1Hour)}
                            </span>
                          )}
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
            {selectedTables.size > 0 && (
              <>
                {excludeMode ? 'Excluding' : 'Including'} {selectedTables.size} table{selectedTables.size !== 1 ? 's' : ''}
                {schemaOnly && ' (Schema Only)'}
                {!schemaOnly && enableReplication && ' (With Replication)'}
              </>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={backingUp || selectedTables.size === 0}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {backingUp ? 'Creating...' : 'Create Backup'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

