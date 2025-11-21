import { useState, useEffect } from 'react';
import Navbar from '@/components/Navbar';
import Link from 'next/link';

interface ServiceGroup {
  serviceName: string;
  tables: string[];
  totalSize?: string;
  sizeBytes?: number;
}

interface TableSizes {
  [table: string]: {
    sizeBytes: number;
    sizeHuman: string;
  };
}

export default function ServiceBackupGroups() {
  const [loading, setLoading] = useState(true);
  const [serviceGroups, setServiceGroups] = useState<ServiceGroup[]>([]);
  const [ungrouped, setUngrouped] = useState<ServiceGroup | null>(null);
  const [tableSizes, setTableSizes] = useState<TableSizes>({});
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [excludedTables, setExcludedTables] = useState<Set<string>>(new Set());
  const [hours, setHours] = useState(24);

  useEffect(() => {
    loadServiceGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours]);

  const loadServiceGroups = async () => {
    try {
      setLoading(true);
      // Get SOURCE_DATABASE_URL from env
      const sourceUrl = process.env.NEXT_PUBLIC_SOURCE_DATABASE_URL || '';
      
      const res = await fetch(`/api/backup/service-groups?connectionString=${encodeURIComponent(sourceUrl)}&hours=${hours}`);
      
      if (!res.ok) {
        throw new Error(`Failed to load service groups: ${res.statusText}`);
      }

      const data = await res.json();
      setServiceGroups(data.serviceGroups || []);
      setUngrouped(data.ungrouped || null);
      setTableSizes(data.tableSizes || {});
    } catch (error: any) {
      console.error('Error loading service groups:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const toggleService = (serviceName: string) => {
    const newSelected = new Set(selectedServices);
    if (newSelected.has(serviceName)) {
      newSelected.delete(serviceName);
    } else {
      newSelected.add(serviceName);
    }
    setSelectedServices(newSelected);
  };

  const toggleTable = (table: string) => {
    const newExcluded = new Set(excludedTables);
    if (newExcluded.has(table)) {
      newExcluded.delete(table);
    } else {
      newExcluded.add(table);
    }
    setExcludedTables(newExcluded);
  };

  const getSelectedTables = () => {
    const tables: string[] = [];
    
    // Add tables from selected services
    serviceGroups
      .filter(g => selectedServices.has(g.serviceName))
      .forEach(g => tables.push(...g.tables));
    
    // Add ungrouped tables if "ungrouped" is selected
    if (selectedServices.has('ungrouped') && ungrouped) {
      tables.push(...ungrouped.tables);
    }
    
    // Remove excluded tables
    return tables.filter(t => !excludedTables.has(t));
  };

  const getTotalSize = (tables: string[]) => {
    const totalBytes = tables.reduce((sum, table) => {
      return sum + (tableSizes[table]?.sizeBytes || 0);
    }, 0);
    return formatBytes(totalBytes);
  };

  const selectedTables = getSelectedTables();
  const totalSize = getTotalSize(selectedTables);

  const createBackupBatch = () => {
    // TODO: Navigate to backup creation with pre-selected tables
    const tableList = selectedTables.join(',');
    window.location.href = `/backup/create?tables=${encodeURIComponent(tableList)}`;
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-gray-600">Loading service groups...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">Service-Based Backup Groups</h1>
                <p className="mt-2 text-sm text-gray-600">
                  Create backup batches by grouping tables by service ownership
                </p>
              </div>
              <Link 
                href="/backup" 
                className="text-blue-600 hover:text-blue-800"
              >
                ← Back to Backups
              </Link>
            </div>
          </div>

          {/* Controls */}
          <div className="bg-white rounded-lg shadow p-4 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <label className="text-sm font-medium text-gray-700">
                  Analysis Window:
                </label>
                <select
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm"
                >
                  <option value={1}>Last hour</option>
                  <option value={6}>Last 6 hours</option>
                  <option value={24}>Last 24 hours</option>
                  <option value={168}>Last week</option>
                </select>
              </div>
              
              <button
                onClick={loadServiceGroups}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm"
              >
                🔄 Refresh
              </button>
            </div>
          </div>

          {/* Selection Summary */}
          {selectedServices.size > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-blue-900">
                    Selected: {selectedServices.size} service(s), {selectedTables.length} table(s)
                  </div>
                  <div className="text-sm text-blue-700 mt-1">
                    Total size: {totalSize}
                    {excludedTables.size > 0 && ` (${excludedTables.size} tables excluded)`}
                  </div>
                </div>
                <button
                  onClick={createBackupBatch}
                  disabled={selectedTables.length === 0}
                  className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  Create Backup Batch →
                </button>
              </div>
            </div>
          )}

          {/* Service Groups */}
          <div className="grid grid-cols-1 gap-4">
            {serviceGroups.map((group) => (
              <div
                key={group.serviceName}
                className={`bg-white rounded-lg shadow border-2 transition-all ${
                  selectedServices.has(group.serviceName)
                    ? 'border-blue-500'
                    : 'border-transparent'
                }`}
              >
                <div
                  className="p-4 cursor-pointer hover:bg-gray-50"
                  onClick={() => toggleService(group.serviceName)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selectedServices.has(group.serviceName)}
                        onChange={() => toggleService(group.serviceName)}
                        className="w-5 h-5 text-blue-600"
                      />
                      <div>
                        <div className="font-semibold text-gray-900">
                          {group.serviceName}
                        </div>
                        <div className="text-sm text-gray-500">
                          {group.tables.length} tables • {group.totalSize}
                        </div>
                      </div>
                    </div>
                    <div>
                      <span className="text-sm text-gray-500">
                        Click to {selectedServices.has(group.serviceName) ? 'deselect' : 'select'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Table List (expanded when selected) */}
                {selectedServices.has(group.serviceName) && (
                  <div className="border-t border-gray-200 p-4 bg-gray-50">
                    <div className="text-sm font-medium text-gray-700 mb-2">
                      Tables in this service:
                    </div>
                    <div className="space-y-1">
                      {group.tables.map((table) => (
                        <div
                          key={table}
                          className="flex items-center justify-between py-2 px-3 bg-white rounded border"
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={!excludedTables.has(table)}
                              onChange={() => toggleTable(table)}
                              className="w-4 h-4 text-blue-600"
                            />
                            <span className="font-mono text-sm">{table}</span>
                          </div>
                          <span className="text-xs text-gray-500">
                            {tableSizes[table]?.sizeHuman || '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Ungrouped Tables */}
            {ungrouped && ungrouped.tables.length > 0 && (
              <div
                className={`bg-white rounded-lg shadow border-2 transition-all ${
                  selectedServices.has('ungrouped')
                    ? 'border-yellow-500'
                    : 'border-transparent'
                }`}
              >
                <div
                  className="p-4 cursor-pointer hover:bg-gray-50"
                  onClick={() => toggleService('ungrouped')}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selectedServices.has('ungrouped')}
                        onChange={() => toggleService('ungrouped')}
                        className="w-5 h-5 text-yellow-600"
                      />
                      <div>
                        <div className="font-semibold text-gray-900">
                          🗂️ Ungrouped Tables
                        </div>
                        <div className="text-sm text-gray-500">
                          {ungrouped.tables.length} tables with no recent service writes • {ungrouped.totalSize}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {selectedServices.has('ungrouped') && (
                  <div className="border-t border-gray-200 p-4 bg-yellow-50">
                    <div className="text-sm font-medium text-gray-700 mb-2">
                      Tables with no recent writes from any service:
                    </div>
                    <div className="space-y-1">
                      {ungrouped.tables.map((table) => (
                        <div
                          key={table}
                          className="flex items-center justify-between py-2 px-3 bg-white rounded border"
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={!excludedTables.has(table)}
                              onChange={() => toggleTable(table)}
                              className="w-4 h-4 text-yellow-600"
                            />
                            <span className="font-mono text-sm">{table}</span>
                          </div>
                          <span className="text-xs text-gray-500">
                            {tableSizes[table]?.sizeHuman || '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Help Text */}
          <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="text-sm text-blue-900">
              <div className="font-semibold mb-2">💡 How Service-Based Grouping Works:</div>
              <ul className="list-disc list-inside space-y-1 text-blue-800">
                <li><strong>Service Groups</strong>: Tables are grouped by which service writes to them (based on application_name in connections)</li>
                <li><strong>Exclusive Ownership</strong>: Tables written by only one service are assigned to that service</li>
                <li><strong>Shared Tables</strong>: Tables written by multiple services are grouped as &quot;shared-tables&quot;</li>
                <li><strong>Ungrouped Tables</strong>: Tables with no recent write activity from any service</li>
                <li><strong>Exclude Large Tables</strong>: Uncheck specific tables to exclude them from the backup batch</li>
                <li><strong>Batch Creation</strong>: Select services → Create a backup batch with all their tables at once</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
