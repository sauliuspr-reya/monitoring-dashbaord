import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Navbar from '@/components/Navbar';

interface PipelineDetail {
  id: string;
  name: string;
  type: 'backup' | 'manual';
  backup?: {
    taskId: string;
    status: string;
    filename?: string;
    filepath?: string;
    fileSize?: number;
    tables?: string[];
    tableCount: number;
    createdAt: string;
    completedAt?: string;
    serviceName?: string;
  };
  publication?: {
    name: string;
    tableCount: number;
    allTables: boolean;
    tables?: string[];
  };
  slot?: {
    name: string;
    restartLsn: string;
    confirmedFlushLsn: string;
    walLagBytes: number;
    walLagPretty: string;
    active: boolean;
  };
  restore?: {
    taskId: string;
    status: string;
    createdAt: string;
    completedAt?: string;
  };
  subscription?: {
    id: string;
    name: string;
    enabled: boolean;
    dataCopy: boolean;
    createdAt: string;
    status: string;
    lagBytes: number;
    lagSeconds: number;
  };
  pipelineStatus: string;
  warnings: string[];
}

export default function PipelineDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  
  const [pipeline, setPipeline] = useState<PipelineDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteOptions, setDeleteOptions] = useState({
    subscription: true,
    slot: true,
    publication: true,
    backup: false,
  });

  useEffect(() => {
    if (!id) return;
    
    const load = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/replication/pipelines/${id}`);
        if (!res.ok) {
          if (res.status === 404) throw new Error('Pipeline not found');
          throw new Error('Failed to load pipeline');
        }
        setPipeline(await res.json());
        setError(null);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    
    load();
  }, [id]);

  const loadPipeline = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/replication/pipelines/${id}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error('Pipeline not found');
        throw new Error('Failed to load pipeline');
      }
      setPipeline(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteArtifact = async (type: 'subscription' | 'slot' | 'publication' | 'backup') => {
    if (!pipeline) return;
    
    const confirmMsg = {
      subscription: `Delete subscription "${pipeline.subscription?.name}"?`,
      slot: `Drop replication slot "${pipeline.slot?.name}"? This will lose ${pipeline.slot?.walLagPretty || '0'} of WAL data.`,
      publication: `Drop publication "${pipeline.publication?.name}"?`,
      backup: `Delete backup file "${pipeline.backup?.filename}"? This cannot be undone.`,
    };

    if (!confirm(confirmMsg[type])) return;

    setDeleting(type);
    try {
      const res = await fetch(`/api/replication/pipelines/${id}/delete-artifact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactType: type }),
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed to delete ${type}`);
      }
      
      await loadPipeline();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setDeleting(null);
    }
  };

  const handleDeletePipeline = async () => {
    if (!pipeline) return;
    
    setDeleting('pipeline');
    try {
      const res = await fetch(`/api/replication/pipelines/${id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deleteOptions),
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete pipeline');
      }
      
      router.push('/replication');
    } catch (err: any) {
      alert(err.message);
      setDeleting(null);
    }
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return '—';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const formatDate = (d?: string) => d ? new Date(d).toLocaleString() : '—';

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-gray-600">Loading pipeline...</div>
        </div>
      </>
    );
  }

  if (error || !pipeline) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-gray-50">
          <div className="max-w-4xl mx-auto px-4 py-8">
            <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
              <div className="text-red-800 font-medium mb-2">Error</div>
              <div className="text-red-600">{error || 'Pipeline not found'}</div>
              <Link href="/replication" className="mt-4 inline-block text-blue-600 hover:text-blue-800">
                ← Back to Pipeline List
              </Link>
            </div>
          </div>
        </div>
      </>
    );
  }

  const statusColors: Record<string, string> = {
    'complete': 'bg-green-100 text-green-800 border-green-200',
    'needs-restore': 'bg-yellow-100 text-yellow-800 border-yellow-200',
    'needs-subscription': 'bg-yellow-100 text-yellow-800 border-yellow-200',
    'wal-accumulating': 'bg-red-100 text-red-800 border-red-200',
    'running': 'bg-blue-100 text-blue-800 border-blue-200',
    'error': 'bg-red-100 text-red-800 border-red-200',
  };

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-4xl mx-auto px-4 py-8">
          {/* Header */}
          <div className="mb-6">
            <Link href="/replication" className="text-sm text-blue-600 hover:text-blue-800 mb-2 inline-block">
              ← Back to Pipeline List
            </Link>
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{pipeline.name}</h1>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`px-2 py-1 text-xs font-medium rounded border ${statusColors[pipeline.pipelineStatus] || 'bg-gray-100'}`}>
                    {pipeline.pipelineStatus.replace('-', ' ').toUpperCase()}
                  </span>
                  <span className="text-sm text-gray-500">
                    {pipeline.type === 'backup' ? 'From Backup' : 'Manual'}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-4 py-2 text-sm text-red-600 border border-red-300 rounded-lg hover:bg-red-50"
              >
                Delete Pipeline
              </button>
            </div>
          </div>

          {/* Warnings */}
          {pipeline.warnings.length > 0 && (
            <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="font-medium text-yellow-800 mb-2">⚠️ Warnings</div>
              {pipeline.warnings.map((w, i) => (
                <div key={i} className="text-sm text-yellow-700">{w}</div>
              ))}
            </div>
          )}

          {/* Pipeline Steps */}
          <div className="space-y-6">
            {/* BACKUP */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="text-lg">💾</span> Backup
                </h2>
                {pipeline.backup && (
                  <button
                    onClick={() => handleDeleteArtifact('backup')}
                    disabled={deleting === 'backup'}
                    className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                  >
                    {deleting === 'backup' ? 'Deleting...' : 'Delete Backup File'}
                  </button>
                )}
              </div>
              <div className="p-4">
                {pipeline.backup ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div><span className="text-gray-500">Status:</span> <span className="font-medium">{pipeline.backup.status}</span></div>
                      <div><span className="text-gray-500">File:</span> <span className="font-mono text-xs">{pipeline.backup.filename}</span></div>
                      <div><span className="text-gray-500">Size:</span> {formatBytes(pipeline.backup.fileSize)}</div>
                      <div><span className="text-gray-500">Tables:</span> {pipeline.backup.tableCount}</div>
                      <div><span className="text-gray-500">Created:</span> {formatDate(pipeline.backup.createdAt)}</div>
                      <div><span className="text-gray-500">Completed:</span> {formatDate(pipeline.backup.completedAt)}</div>
                    </div>
                    {pipeline.backup.serviceName && (
                      <div className="text-sm">
                        <span className="text-gray-500">Service:</span>{' '}
                        <span className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded text-xs">{pipeline.backup.serviceName}</span>
                      </div>
                    )}
                    <div className="pt-2">
                      <Link href={`/backup?task=${pipeline.backup.taskId}`} className="text-sm text-blue-600 hover:text-blue-800">
                        View Backup Logs →
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div className="text-gray-500 text-sm">No backup associated with this pipeline</div>
                )}
              </div>
            </div>

            {/* PUBLICATION */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="text-lg">📰</span> Publication
                </h2>
                {pipeline.publication && !pipeline.subscription && (
                  <button
                    onClick={() => handleDeleteArtifact('publication')}
                    disabled={deleting === 'publication'}
                    className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                  >
                    {deleting === 'publication' ? 'Dropping...' : 'Drop Publication'}
                  </button>
                )}
              </div>
              <div className="p-4">
                {pipeline.publication ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div><span className="text-gray-500">Name:</span> <span className="font-mono">{pipeline.publication.name}</span></div>
                      <div><span className="text-gray-500">Tables:</span> {pipeline.publication.allTables ? 'ALL TABLES' : pipeline.publication.tableCount}</div>
                    </div>
                    {pipeline.publication.tables && pipeline.publication.tables.length > 0 && (
                      <details className="text-sm">
                        <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                          View {pipeline.publication.tables.length} tables
                        </summary>
                        <div className="mt-2 max-h-48 overflow-y-auto bg-gray-50 rounded p-2">
                          <div className="grid grid-cols-2 gap-1 font-mono text-xs">
                            {pipeline.publication.tables.map(t => (
                              <div key={t} className="truncate">{t}</div>
                            ))}
                          </div>
                        </div>
                      </details>
                    )}
                  </div>
                ) : (
                  <div className="text-gray-500 text-sm">No publication found</div>
                )}
              </div>
            </div>

            {/* SLOT */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="text-lg">🎰</span> Replication Slot
                </h2>
                {pipeline.slot && !pipeline.slot.active && (
                  <button
                    onClick={() => handleDeleteArtifact('slot')}
                    disabled={deleting === 'slot'}
                    className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                  >
                    {deleting === 'slot' ? 'Dropping...' : 'Drop Slot'}
                  </button>
                )}
              </div>
              <div className="p-4">
                {pipeline.slot ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div><span className="text-gray-500">Name:</span> <span className="font-mono">{pipeline.slot.name}</span></div>
                      <div>
                        <span className="text-gray-500">Status:</span>{' '}
                        <span className={pipeline.slot.active ? 'text-green-600' : 'text-gray-500'}>
                          {pipeline.slot.active ? '● Active' : '○ Inactive'}
                        </span>
                      </div>
                      <div><span className="text-gray-500">Restart LSN:</span> <span className="font-mono text-xs">{pipeline.slot.restartLsn}</span></div>
                      <div><span className="text-gray-500">Confirmed LSN:</span> <span className="font-mono text-xs">{pipeline.slot.confirmedFlushLsn}</span></div>
                      <div className="col-span-2">
                        <span className="text-gray-500">WAL Lag:</span>{' '}
                        <span className={pipeline.slot.walLagBytes > 100 * 1024 * 1024 ? 'text-red-600 font-medium' : ''}>
                          {pipeline.slot.walLagPretty} ({formatBytes(pipeline.slot.walLagBytes)})
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-gray-500 text-sm">No replication slot</div>
                )}
              </div>
            </div>

            {/* RESTORE */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-4 border-b border-gray-200">
                <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="text-lg">📥</span> Restore
                </h2>
              </div>
              <div className="p-4">
                {pipeline.restore ? (
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div><span className="text-gray-500">Status:</span> <span className="font-medium">{pipeline.restore.status}</span></div>
                    <div><span className="text-gray-500">Created:</span> {formatDate(pipeline.restore.createdAt)}</div>
                    <div><span className="text-gray-500">Completed:</span> {formatDate(pipeline.restore.completedAt)}</div>
                  </div>
                ) : pipeline.backup?.status === 'completed' ? (
                  <div className="space-y-2">
                    <div className="text-yellow-600 text-sm font-medium">⚠️ Backup not yet restored</div>
                    <Link
                      href={`/backup?restore=${pipeline.backup.taskId}`}
                      className="inline-block px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                    >
                      Restore Now
                    </Link>
                  </div>
                ) : (
                  <div className="text-gray-500 text-sm">No restore task</div>
                )}
              </div>
            </div>

            {/* SUBSCRIPTION */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="text-lg">🔄</span> Subscription
                </h2>
                {pipeline.subscription && (
                  <button
                    onClick={() => handleDeleteArtifact('subscription')}
                    disabled={deleting === 'subscription'}
                    className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                  >
                    {deleting === 'subscription' ? 'Deleting...' : 'Delete Subscription'}
                  </button>
                )}
              </div>
              <div className="p-4">
                {pipeline.subscription ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div><span className="text-gray-500">Name:</span> <span className="font-medium">{pipeline.subscription.name}</span></div>
                      <div>
                        <span className="text-gray-500">Status:</span>{' '}
                        <span className={pipeline.subscription.enabled ? 'text-green-600' : 'text-gray-500'}>
                          {pipeline.subscription.enabled ? '● Enabled' : '○ Disabled'}
                        </span>
                      </div>
                      <div><span className="text-gray-500">Created:</span> {formatDate(pipeline.subscription.createdAt)}</div>
                      <div><span className="text-gray-500">data_copy:</span> {pipeline.subscription.dataCopy ? 'true' : 'false'}</div>
                      <div><span className="text-gray-500">Lag:</span> {formatBytes(pipeline.subscription.lagBytes)} / {pipeline.subscription.lagSeconds}s</div>
                    </div>
                    <div className="pt-2">
                      <Link href={`/subscriptions/${pipeline.subscription.id}`} className="text-sm text-blue-600 hover:text-blue-800">
                        View Subscription Details →
                      </Link>
                    </div>
                  </div>
                ) : pipeline.restore?.status === 'completed' || pipeline.type === 'manual' ? (
                  <div className="space-y-2">
                    <div className="text-yellow-600 text-sm font-medium">⚠️ No subscription created</div>
                    <Link
                      href={`/subscriptions/new?publication=${encodeURIComponent(pipeline.publication?.name || '')}${pipeline.slot ? `&slot=${encodeURIComponent(pipeline.slot.name)}` : ''}`}
                      className="inline-block px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                    >
                      Create Subscription
                    </Link>
                  </div>
                ) : (
                  <div className="text-gray-500 text-sm">Waiting for restore to complete</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Delete Pipeline</h3>
            <p className="text-sm text-gray-600 mb-4">
              Select which artifacts to delete along with the pipeline:
            </p>
            
            <div className="space-y-3 mb-6">
              {pipeline.subscription && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={deleteOptions.subscription}
                    onChange={e => setDeleteOptions(o => ({ ...o, subscription: e.target.checked }))}
                    className="rounded"
                  />
                  <span className="text-sm">Delete Subscription ({pipeline.subscription.name})</span>
                </label>
              )}
              {pipeline.slot && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={deleteOptions.slot}
                    onChange={e => setDeleteOptions(o => ({ ...o, slot: e.target.checked }))}
                    className="rounded"
                  />
                  <span className="text-sm">Drop Replication Slot ({pipeline.slot.name})</span>
                  {pipeline.slot.walLagBytes > 0 && (
                    <span className="text-xs text-red-600">({pipeline.slot.walLagPretty} WAL)</span>
                  )}
                </label>
              )}
              {pipeline.publication && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={deleteOptions.publication}
                    onChange={e => setDeleteOptions(o => ({ ...o, publication: e.target.checked }))}
                    className="rounded"
                  />
                  <span className="text-sm">Drop Publication ({pipeline.publication.name})</span>
                </label>
              )}
              {pipeline.backup && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={deleteOptions.backup}
                    onChange={e => setDeleteOptions(o => ({ ...o, backup: e.target.checked }))}
                    className="rounded"
                  />
                  <span className="text-sm text-red-600">Delete Backup File ({pipeline.backup.filename})</span>
                </label>
              )}
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeletePipeline}
                disabled={deleting === 'pipeline'}
                className="px-4 py-2 text-sm text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50"
              >
                {deleting === 'pipeline' ? 'Deleting...' : 'Delete Pipeline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
