import { useState, useEffect, useMemo } from 'react';

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
  lastBackupDate?: string;
  lastBackupId?: string;
}

type SortColumn = 'table' | 'rows' | 'size' | 'writers' | 'lastBackup';
type SortDirection = 'asc' | 'desc';

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
  initialTables?: string[];
  initialExcludeTables?: string[];
  initialSchemaOnly?: boolean;
  initialEnableReplication?: boolean;
  initialExcludeMode?: boolean;
}

export default function BackupModal({
  isOpen,
  onClose,
  tables,
  loading,
  onBackup,
  backingUp,
  initialTables,
  initialExcludeTables,
  initialSchemaOnly,
  initialEnableReplication,
  initialExcludeMode,
}: BackupModalProps) {
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [excludeMode, setExcludeMode] = useState(initialExcludeMode || false);
  const [searchQuery, setSearchQuery] = useState('');
  const [schemaOnly, setSchemaOnly] = useState(initialSchemaOnly || false);
  const [enableReplication, setEnableReplication] = useState(initialEnableReplication !== undefined ? initialEnableReplication : true);
  const [sortColumn, setSortColumn] = useState<SortColumn>('table');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [backupInfoMap, setBackupInfoMap] = useState<Map<string, { lastBackupDate?: string; lastBackupId?: string }>>(new Map());
  const [showPasteList, setShowPasteList] = useState(false);
  const [pasteListText, setPasteListText] = useState('');

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

  // Initialize from props when modal opens
  useEffect(() => {
    if (isOpen) {
      if (initialTables && initialTables.length > 0) {
        setSelectedTables(new Set(initialTables));
        setExcludeMode(false);
      } else if (initialExcludeTables && initialExcludeTables.length > 0) {
        setSelectedTables(new Set(initialExcludeTables));
        setExcludeMode(true);
      } else {
        setSelectedTables(new Set());
      }
      
      if (initialSchemaOnly !== undefined) {
        setSchemaOnly(initialSchemaOnly);
      }
      if (initialEnableReplication !== undefined) {
        setEnableReplication(initialEnableReplication);
      }
      if (initialExcludeMode !== undefined) {
        setExcludeMode(initialExcludeMode);
      }
      
      // Reset other state
      setSearchQuery('');
      setPasteListText('');
      setShowPasteList(false);
    }
  }, [isOpen, initialTables, initialExcludeTables, initialSchemaOnly, initialEnableReplication, initialExcludeMode]);

  const formatDate = (dateString?: string) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // Fetch backup info when modal opens
  useEffect(() => {
    if (isOpen) {
      fetch('/api/tables/backup-info')
        .then(res => res.json())
        .then(data => {
          const map = new Map();
          (data.backupInfo || []).forEach((info: any) => {
            map.set(info.tableName, {
              lastBackupDate: info.lastBackupDate,
              lastBackupId: info.lastBackupId,
            });
          });
          setBackupInfoMap(map);
        })
        .catch(err => console.error('Error fetching backup info:', err));
    }
  }, [isOpen]);

  // Merge backup info into tables
  const tablesWithBackupInfo = useMemo(() => {
    return tables.map(table => {
      // Try exact match first, then lowercase match
      const backupInfo = backupInfoMap.get(table.table) || 
                        backupInfoMap.get(table.table.toLowerCase()) ||
                        backupInfoMap.get(table.tableName) ||
                        backupInfoMap.get(table.tableName.toLowerCase());
      return {
        ...table,
        lastBackupDate: backupInfo?.lastBackupDate,
        lastBackupId: backupInfo?.lastBackupId,
      };
    });
  }, [tables, backupInfoMap]);

  const filteredTables = tablesWithBackupInfo.filter(table =>
    table.table.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Sort tables
  const sortedTables = useMemo(() => {
    const sorted = [...filteredTables];
    sorted.sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch (sortColumn) {
        case 'table':
          aVal = a.table.toLowerCase();
          bVal = b.table.toLowerCase();
          break;
        case 'rows':
          aVal = a.sourceRowCount;
          bVal = b.sourceRowCount;
          break;
        case 'size':
          aVal = a.sourceSize;
          bVal = b.sourceSize;
          break;
        case 'writers':
          // Get writer count for sorting
          const aSourceCount = a.writersOnSource?.length || 0;
          const aTargetCount = a.writersOnTarget?.length || 0;
          const bSourceCount = b.writersOnSource?.length || 0;
          const bTargetCount = b.writersOnTarget?.length || 0;
          aVal = aSourceCount + aTargetCount;
          bVal = bSourceCount + bTargetCount;
          break;
        case 'lastBackup':
          aVal = a.lastBackupDate ? new Date(a.lastBackupDate).getTime() : 0;
          bVal = b.lastBackupDate ? new Date(b.lastBackupDate).getTime() : 0;
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filteredTables, sortColumn, sortDirection]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const SortIcon = ({ column }: { column: SortColumn }) => {
    if (sortColumn !== column) {
      return <span className="text-gray-400 ml-1">↕</span>;
    }
    return sortDirection === 'asc' ? (
      <span className="text-blue-600 ml-1">↑</span>
    ) : (
      <span className="text-blue-600 ml-1">↓</span>
    );
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

  const selectAll = () => {
    setSelectedTables(new Set(sortedTables.map(t => t.table)));
  };

  const deselectAll = () => {
    setSelectedTables(new Set());
  };

  // Parse table list from text (handles newlines, spaces, commas)
  const parseTableList = (text: string): string[] => {
    if (!text.trim()) return [];
    
    // Split by newlines, commas, or spaces, then clean up
    const parts = text
      .split(/[\n,\s]+/)
      .map(part => part.trim())
      .filter(part => part.length > 0);
    
    return parts;
  };

  // Normalize table name for matching (remove quotes, schema prefix, lowercase)
  const normalizeTableName = (name: string): string => {
    return name
      .replace(/^public\./i, '')
      .replace(/^["']|["']$/g, '')
      .toLowerCase()
      .trim();
  };

  // Load tables from pasted text
  const loadTablesFromPaste = () => {
    const parsedNames = parseTableList(pasteListText);
    if (parsedNames.length === 0) {
      alert('No table names found in the pasted text');
      return;
    }

    const matchedTables = new Set<string>();
    const notFound: string[] = [];

    parsedNames.forEach(parsedName => {
      const normalizedParsed = normalizeTableName(parsedName);
      
      // Try to find matching table
      const found = tables.find(table => {
        const normalizedTable = normalizeTableName(table.table);
        const normalizedTableName = normalizeTableName(table.tableName);
        return normalizedTable === normalizedParsed || normalizedTableName === normalizedParsed;
      });

      if (found) {
        matchedTables.add(found.table);
      } else {
        notFound.push(parsedName);
      }
    });

    if (matchedTables.size > 0) {
      setSelectedTables(matchedTables);
      setPasteListText('');
      setShowPasteList(false);
      
      if (notFound.length > 0) {
        alert(`Loaded ${matchedTables.size} table(s). ${notFound.length} table(s) not found: ${notFound.slice(0, 10).join(', ')}${notFound.length > 10 ? '...' : ''}`);
      } else {
        alert(`Successfully loaded ${matchedTables.size} table(s)`);
      }
    } else {
      alert(`No matching tables found. Please check the table names.\n\nNot found: ${notFound.slice(0, 10).join(', ')}${notFound.length > 10 ? '...' : ''}`);
    }
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
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-2">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-[95vw] h-full max-h-[95vh] flex flex-col">
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

          {/* Search and Paste List */}
          <div className="mb-4 space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tables..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => setShowPasteList(!showPasteList)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                {showPasteList ? '✕ Hide' : '📋 Paste List'}
              </button>
            </div>
            
            {showPasteList && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Paste table names (one per line, or comma/space separated):
                </label>
                <textarea
                  value={pasteListText}
                  onChange={(e) => setPasteListText(e.target.value)}
                  placeholder={`AccountBalanceSeries\nAccountCollateralBalanceSeries\nAccountTotalBalanceSeries\n...`}
                  rows={6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={loadTablesFromPaste}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
                  >
                    Load Tables
                  </button>
                  <button
                    onClick={() => {
                      setPasteListText('');
                      setShowPasteList(false);
                    }}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                  >
                    Clear
                  </button>
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Supports newline, comma, or space-separated table names. Will match against available tables.
                </p>
              </div>
            )}
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
              {sortedTables.length} table{sortedTables.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Tables Table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto" style={{ maxHeight: '60vh' }}>
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 w-12">
                      <input
                        type="checkbox"
                        checked={sortedTables.length > 0 && sortedTables.every(t => selectedTables.has(t.table))}
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
                    <th 
                      className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase cursor-pointer hover:bg-gray-100 select-none"
                      onClick={() => handleSort('table')}
                    >
                      Table <SortIcon column="table" />
                    </th>
                    <th 
                      className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase cursor-pointer hover:bg-gray-100 select-none"
                      onClick={() => handleSort('rows')}
                    >
                      Rows <SortIcon column="rows" />
                    </th>
                    <th 
                      className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase cursor-pointer hover:bg-gray-100 select-none"
                      onClick={() => handleSort('size')}
                    >
                      Size <SortIcon column="size" />
                    </th>
                    <th 
                      className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase cursor-pointer hover:bg-gray-100 select-none"
                      onClick={() => handleSort('writers')}
                    >
                      Writers <SortIcon column="writers" />
                    </th>
                    <th 
                      className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase cursor-pointer hover:bg-gray-100 select-none"
                      onClick={() => handleSort('lastBackup')}
                    >
                      Last Backup <SortIcon column="lastBackup" />
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Backup ID</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                        Loading tables...
                      </td>
                    </tr>
                  ) : sortedTables.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                        No tables found
                      </td>
                    </tr>
                  ) : (
                    sortedTables.map((table) => (
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
                        <td className="px-4 py-2 text-sm text-gray-600">
                          {table.lastBackupDate ? (
                            <div className="flex flex-col">
                              <span className="text-xs" title={new Date(table.lastBackupDate).toLocaleString()}>
                                {formatDate(table.lastBackupDate)}
                              </span>
                              <span className="text-xs text-gray-500 mt-0.5">
                                {new Date(table.lastBackupDate).toLocaleDateString()}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-600">
                          {table.lastBackupId ? (
                            <div className="flex flex-col">
                              <span className="text-xs font-mono text-blue-600" title={table.lastBackupId}>
                                {table.lastBackupId.substring(0, 8)}...
                              </span>
                              <span className="text-xs text-gray-500 mt-0.5 font-mono">
                                {table.lastBackupId.substring(8, 16)}...
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
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

