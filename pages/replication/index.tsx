import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import Navbar from '@/components/Navbar';
import type { PipelineItem } from '../api/replication/pipelines';

type SortMode = 'action-needed' | 'date-desc' | 'date-asc' | 'name';
type FilterMode = 'all' | 'complete' | 'needs-action' | 'running' | 'errors';

interface PipelinesData {
  pipelines: PipelineItem[];
  summary: {
    total: number;
    complete: number;
    needsAction: number;
    running: number;
    errors: number;
    runningJobs: number;
  };
}

export default function ReplicationPipelinePage() {
  const [data, setData] = useState<PipelinesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('action-needed');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [groupByService, setGroupByService] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [bulkDeleteOptions, setBulkDeleteOptions] = useState({
    subscription: true,
    slot: true,
    publication: true,
    backup: false,
  });

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const res = await fetch('/api/replication/pipelines');
      if (!res.ok) throw new Error('Failed to load pipeline data');
      setData(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const sortedAndFiltered = useMemo(() => {
    if (!data) return [];
    let items = [...data.pipelines];

    // Filter
    switch (filterMode) {
      case 'complete':
        items = items.filter(p => p.pipelineStatus === 'complete');
        break;
      case 'needs-action':
        items = items.filter(p => ['needs-restore', 'needs-subscription', 'wal-accumulating'].includes(p.pipelineStatus));
        break;
      case 'running':
        items = items.filter(p => p.pipelineStatus === 'running');
        break;
      case 'errors':
        items = items.filter(p => p.pipelineStatus === 'error');
        break;
    }

    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.backup?.filename?.toLowerCase().includes(q) ||
        p.publication?.name.toLowerCase().includes(q) ||
        p.subscription?.name.toLowerCase().includes(q)
      );
    }

    // Sort
    switch (sortMode) {
      case 'action-needed':
        const priority: Record<string, number> = {
          'running': 0,
          'wal-accumulating': 1,
          'needs-subscription': 2,
          'needs-restore': 3,
          'error': 4,
          'complete': 5,
        };
        items.sort((a, b) => (priority[a.pipelineStatus] ?? 99) - (priority[b.pipelineStatus] ?? 99));
        break;
      case 'date-desc':
        items.sort((a, b) => (b.backup?.createdAt || '').localeCompare(a.backup?.createdAt || ''));
        break;
      case 'date-asc':
        items.sort((a, b) => (a.backup?.createdAt || '').localeCompare(b.backup?.createdAt || ''));
        break;
      case 'name':
        items.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    return items;
  }, [data, filterMode, searchQuery, sortMode]);

  // Group by service if enabled
  const grouped = useMemo(() => {
    if (!groupByService) return { '': sortedAndFiltered };
    const groups: Record<string, PipelineItem[]> = {};
    for (const item of sortedAndFiltered) {
      const service = item.backup?.serviceName || 'Other';
      if (!groups[service]) groups[service] = [];
      groups[service].push(item);
    }
    return groups;
  }, [sortedAndFiltered, groupByService]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === sortedAndFiltered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedAndFiltered.map(p => p.id)));
    }
  };

  const handleDelete = async (id: string, options?: { subscription?: boolean; slot?: boolean; publication?: boolean; backup?: boolean }) => {
    const pipeline = data?.pipelines.find(p => p.id === id);
    if (!pipeline) return;
    
    const opts = options || { subscription: true, slot: true, publication: true, backup: false };
    
    setDeleting(id);
    try {
      const res = await fetch(`/api/replication/pipelines/${id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete pipeline');
      }
      
      await loadData();
      selectedIds.delete(id);
      setSelectedIds(new Set(selectedIds));
    } catch (err: any) {
      alert(err.message);
    } finally {
      setDeleting(null);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    setShowBulkDelete(false);
    
    for (const id of ids) {
      await handleDelete(id, bulkDeleteOptions);
    }
    
    setSelectedIds(new Set());
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return '—';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const formatDate = (d?: string) => {
    if (!d) return '—';
    return new Date(d).toLocaleString();
  };

  const getStatusBadge = (status: PipelineItem['pipelineStatus']) => {
    const styles: Record<string, string> = {
      'complete': 'bg-green-100 text-green-800',
      'needs-restore': 'bg-yellow-100 text-yellow-800',
      'needs-subscription': 'bg-yellow-100 text-yellow-800',
      'wal-accumulating': 'bg-red-100 text-red-800',
      'running': 'bg-blue-100 text-blue-800',
      'error': 'bg-red-100 text-red-800',
    };
    const labels: Record<string, string> = {
      'complete': '● Complete',
      'needs-restore': '◐ Needs Restore',
      'needs-subscription': '◐ Needs Subscription',
      'wal-accumulating': '⚠️ WAL Accumulating',
      'running': '◌ Running',
      'error': '✕ Error',
    };
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${styles[status]}`}>
        {labels[status]}
      </span>
    );
  };

  if (loading && !data) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-gray-600">Loading replication pipelines...</div>
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
          <div className="mb-6 flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Replication Pipeline</h1>
              <p className="mt-1 text-gray-600">Backup → Restore → Subscription</p>
            </div>
            <div className="flex gap-2">
              <Link href="/backup" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">
                + New Backup
              </Link>
            </div>
          </div>

          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">{error}</div>
          )}

          {/* Summary Stats */}
          {data && (
            <div className="mb-6 grid grid-cols-2 md:grid-cols-5 gap-4">
              <button
                onClick={() => setFilterMode('all')}
                className={`bg-white rounded-lg shadow p-4 text-left hover:ring-2 hover:ring-blue-500 ${filterMode === 'all' ? 'ring-2 ring-blue-500' : ''}`}
              >
                <div className="text-2xl font-bold text-gray-900">{data.summary.total}</div>
                <div className="text-sm text-gray-500">Total Pipelines</div>
              </button>
              <button
                onClick={() => setFilterMode('complete')}
                className={`bg-white rounded-lg shadow p-4 text-left hover:ring-2 hover:ring-green-500 ${filterMode === 'complete' ? 'ring-2 ring-green-500' : ''}`}
              >
                <div className="text-2xl font-bold text-green-600">{data.summary.complete}</div>
                <div className="text-sm text-gray-500">Complete</div>
              </button>
              <button
                onClick={() => setFilterMode('needs-action')}
                className={`bg-white rounded-lg shadow p-4 text-left hover:ring-2 hover:ring-yellow-500 ${filterMode === 'needs-action' ? 'ring-2 ring-yellow-500' : ''}`}
              >
                <div className="text-2xl font-bold text-yellow-600">{data.summary.needsAction}</div>
                <div className="text-sm text-gray-500">Needs Action</div>
              </button>
              <button
                onClick={() => setFilterMode('running')}
                className={`bg-white rounded-lg shadow p-4 text-left hover:ring-2 hover:ring-blue-500 ${filterMode === 'running' ? 'ring-2 ring-blue-500' : ''}`}
              >
                <div className="text-2xl font-bold text-blue-600">{data.summary.running}</div>
                <div className="text-sm text-gray-500">Running</div>
              </button>
              <button
                onClick={() => setFilterMode('errors')}
                className={`bg-white rounded-lg shadow p-4 text-left hover:ring-2 hover:ring-red-500 ${filterMode === 'errors' ? 'ring-2 ring-red-500' : ''}`}
              >
                <div className="text-2xl font-bold text-red-600">{data.summary.errors}</div>
                <div className="text-sm text-gray-500">Errors</div>
              </button>
            </div>
          )}

          {/* Controls */}
          <div className="mb-6 bg-white rounded-lg shadow p-4 flex flex-wrap gap-4 items-center justify-between">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedIds.size > 0 && selectedIds.size === sortedAndFiltered.length}
                  onChange={toggleSelectAll}
                  className="rounded"
                />
                Select All
              </label>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">Sort:</label>
                <select
                  value={sortMode}
                  onChange={e => setSortMode(e.target.value as SortMode)}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md"
                >
                  <option value="action-needed">Action Needed First</option>
                  <option value="date-desc">Newest First</option>
                  <option value="date-asc">Oldest First</option>
                  <option value="name">Name</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={groupByService}
                  onChange={e => setGroupByService(e.target.checked)}
                  className="rounded"
                />
                Group by Service
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search pipelines..."
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md w-64"
              />
              <button onClick={loadData} className="px-3 py-1.5 text-sm bg-gray-100 rounded-md hover:bg-gray-200">
                ↻ Refresh
              </button>
            </div>
          </div>

          {/* Bulk Actions Bar */}
          {selectedIds.size > 0 && (
            <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-blue-800">{selectedIds.size} pipeline(s) selected</span>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Clear selection
                </button>
              </div>
              <button
                onClick={() => setShowBulkDelete(true)}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700"
              >
                Delete Selected
              </button>
            </div>
          )}

          {/* Running Jobs Banner */}
          {data && data.summary.runningJobs > 0 && (
            <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 bg-blue-500 rounded-full animate-pulse"></span>
                <span className="text-blue-800 font-medium">{data.summary.runningJobs} job(s) running</span>
              </div>
              <Link href="/backup" className="text-blue-600 hover:text-blue-800 text-sm">
                View Jobs →
              </Link>
            </div>
          )}

          {/* Pipeline Cards */}
          {Object.entries(grouped).map(([serviceName, items]) => (
            <div key={serviceName} className="mb-8">
              {groupByService && serviceName && (
                <h2 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
                  <span className="px-2 py-1 bg-gray-200 rounded text-sm">{serviceName}</span>
                  <span className="text-gray-400 text-sm font-normal">({items.length} pipelines)</span>
                </h2>
              )}
              <div className="space-y-4">
                {items.map(pipeline => (
                  <PipelineCard
                    key={pipeline.id}
                    pipeline={pipeline}
                    formatBytes={formatBytes}
                    formatDate={formatDate}
                    getStatusBadge={getStatusBadge}
                    onRefresh={loadData}
                    selected={selectedIds.has(pipeline.id)}
                    onToggleSelect={() => toggleSelect(pipeline.id)}
                    onDelete={() => {
                      if (confirm(`Delete pipeline "${pipeline.name}"? This will delete subscription, slot, and publication.`)) {
                        handleDelete(pipeline.id);
                      }
                    }}
                    isDeleting={deleting === pipeline.id}
                  />
                ))}
              </div>
            </div>
          ))}

          {sortedAndFiltered.length === 0 && (
            <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
              No pipelines found matching your criteria
            </div>
          )}
        </div>
      </div>

      {/* Bulk Delete Modal */}
      {showBulkDelete && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Delete {selectedIds.size} Pipeline(s)</h3>
            <p className="text-sm text-gray-600 mb-4">
              Select which artifacts to delete:
            </p>
            
            <div className="space-y-3 mb-6">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bulkDeleteOptions.subscription}
                  onChange={e => setBulkDeleteOptions(o => ({ ...o, subscription: e.target.checked }))}
                  className="rounded"
                />
                <span className="text-sm">Delete Subscriptions</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bulkDeleteOptions.slot}
                  onChange={e => setBulkDeleteOptions(o => ({ ...o, slot: e.target.checked }))}
                  className="rounded"
                />
                <span className="text-sm">Drop Replication Slots</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bulkDeleteOptions.publication}
                  onChange={e => setBulkDeleteOptions(o => ({ ...o, publication: e.target.checked }))}
                  className="rounded"
                />
                <span className="text-sm">Drop Publications</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bulkDeleteOptions.backup}
                  onChange={e => setBulkDeleteOptions(o => ({ ...o, backup: e.target.checked }))}
                  className="rounded"
                />
                <span className="text-sm text-red-600">Delete Backup Files (cannot be undone)</span>
              </label>
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowBulkDelete(false)}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                className="px-4 py-2 text-sm text-white bg-red-600 rounded hover:bg-red-700"
              >
                Delete {selectedIds.size} Pipeline(s)
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PipelineCard({
  pipeline,
  formatBytes,
  formatDate,
  getStatusBadge,
  onRefresh,
  selected,
  onToggleSelect,
  onDelete,
  isDeleting,
}: {
  pipeline: PipelineItem;
  formatBytes: (b?: number) => string;
  formatDate: (d?: string) => string;
  getStatusBadge: (s: PipelineItem['pipelineStatus']) => JSX.Element;
  onRefresh: () => void;
  selected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const borderColor = {
    'complete': 'border-green-500',
    'needs-restore': 'border-yellow-500',
    'needs-subscription': 'border-yellow-500',
    'wal-accumulating': 'border-red-500',
    'running': 'border-blue-500',
    'error': 'border-red-500',
  }[pipeline.pipelineStatus];

  return (
    <div className={`bg-white rounded-lg shadow border-l-4 ${borderColor} overflow-hidden`}>
      {/* Header */}
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              className="rounded w-4 h-4"
              onClick={e => e.stopPropagation()}
            />
            <span className="text-xl">{pipeline.type === 'backup' ? '📦' : '📄'}</span>
            <div>
              <h3 className="font-semibold text-gray-900">{pipeline.name}</h3>
              {pipeline.backup?.serviceName && (
                <span className="text-xs text-gray-500">Service: {pipeline.backup.serviceName}</span>
              )}
            </div>
          </div>
          {getStatusBadge(pipeline.pipelineStatus)}
        </div>
      </div>

      {/* Pipeline Steps */}
      <div className="p-4 grid grid-cols-3 gap-4">
        {/* BACKUP */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Backup</div>
          {pipeline.backup ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                {pipeline.backup.status === 'completed' ? '✅' : pipeline.backup.status === 'running' ? '⏳' : '❌'}
                <span className="text-sm font-medium">{pipeline.backup.filename || 'In progress...'}</span>
              </div>
              <div className="text-xs text-gray-500">
                📊 {pipeline.backup.tableCount} tables, {formatBytes(pipeline.backup.fileSize)}
              </div>
              <div className="text-xs text-gray-500">
                📅 {formatDate(pipeline.backup.createdAt)}
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-400">— No backup</div>
          )}
        </div>

        {/* RESTORE */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Restore</div>
          {pipeline.restore ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                {pipeline.restore.status === 'completed' ? '✅' : pipeline.restore.status === 'running' ? '⏳' : '❌'}
                <span className="text-sm font-medium">Restored to GCP</span>
              </div>
              <div className="text-xs text-gray-500">
                📅 {formatDate(pipeline.restore.completedAt || pipeline.restore.createdAt)}
              </div>
            </div>
          ) : pipeline.backup?.status === 'completed' ? (
            <div className="space-y-1">
              <div className="text-sm text-yellow-600 font-medium">⚠️ Not restored</div>
              <Link
                href={`/backup?restore=${pipeline.backup.taskId}`}
                className="inline-block text-xs text-blue-600 hover:text-blue-800"
              >
                → Restore now
              </Link>
            </div>
          ) : (
            <div className="text-sm text-gray-400">— N/A</div>
          )}
        </div>

        {/* SUBSCRIPTION */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Subscription</div>
          {pipeline.subscription ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${pipeline.subscription.enabled ? 'bg-green-500' : 'bg-gray-400'}`}></span>
                <Link href={`/subscriptions/${pipeline.subscription.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-800">
                  {pipeline.subscription.name}
                </Link>
              </div>
              <div className="text-xs text-gray-500">
                📅 {formatDate(pipeline.subscription.createdAt)}
              </div>
              <div className="text-xs text-gray-500">
                {pipeline.subscription.enabled ? '🟢 Active' : '⚪ Disabled'}
                {pipeline.subscription.lagBytes > 0 && `, Lag: ${formatBytes(pipeline.subscription.lagBytes)}`}
              </div>
            </div>
          ) : pipeline.restore?.status === 'completed' || pipeline.type === 'manual' ? (
            <div className="space-y-1">
              <div className="text-sm text-yellow-600 font-medium">⚠️ Not created</div>
              <Link
                href={`/subscriptions/new?publication=${encodeURIComponent(pipeline.publication?.name || '')}${pipeline.slot ? `&slot=${encodeURIComponent(pipeline.slot.name)}` : ''}`}
                className="inline-block text-xs text-blue-600 hover:text-blue-800"
              >
                → Create subscription
              </Link>
            </div>
          ) : (
            <div className="text-sm text-gray-400">— Waiting for restore</div>
          )}
        </div>
      </div>

      {/* Slot Info */}
      {pipeline.slot && (
        <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium">🎰 Slot:</span>
            <span className="font-mono text-xs">{pipeline.slot.name}</span>
            <span className="text-gray-500">LSN: {pipeline.slot.restartLsn} → {pipeline.slot.confirmedFlushLsn}</span>
            <span className={pipeline.slot.walLagBytes > 100 * 1024 * 1024 ? 'text-red-600 font-medium' : 'text-gray-500'}>
              WAL: {pipeline.slot.walLagPretty}
            </span>
            <span className={pipeline.slot.active ? 'text-green-600' : 'text-gray-400'}>
              {pipeline.slot.active ? '● Active' : '○ Inactive'}
            </span>
          </div>
        </div>
      )}

      {/* Warnings */}
      {pipeline.warnings.length > 0 && (
        <div className="px-4 py-2 bg-yellow-50 border-t border-yellow-100">
          {pipeline.warnings.map((w, i) => (
            <div key={i} className="text-sm text-yellow-800">⚠️ {w}</div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex gap-2">
        <Link
          href={`/replication/${pipeline.id}`}
          className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-100"
        >
          View Details
        </Link>
        {pipeline.backup && (
          <Link
            href={`/backup?task=${pipeline.backup.taskId}`}
            className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-100"
          >
            View Logs
          </Link>
        )}
        {pipeline.pipelineStatus === 'wal-accumulating' && pipeline.slot && !pipeline.subscription && (
          <button
            onClick={() => {
              if (confirm(`Drop slot "${pipeline.slot!.name}"? This will lose ${pipeline.slot!.walLagPretty} of WAL.`)) {
                fetch(`/api/replication/pipelines/${pipeline.id}/delete-artifact`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ artifactType: 'slot' }),
                }).then(() => onRefresh()).catch(e => alert(e.message));
              }
            }}
            className="px-3 py-1.5 text-sm text-red-600 border border-red-300 rounded hover:bg-red-50"
          >
            Drop Slot
          </button>
        )}
        <button
          onClick={onDelete}
          disabled={isDeleting}
          className="px-3 py-1.5 text-sm text-red-600 border border-red-300 rounded hover:bg-red-50 disabled:opacity-50 ml-auto"
        >
          {isDeleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </div>
  );
}
