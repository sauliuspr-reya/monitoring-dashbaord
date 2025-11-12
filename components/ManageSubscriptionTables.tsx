import { useState, useEffect } from 'react';

interface Table {
  name: string;
  size: string;
  sizeBytes: number;
  status: 'in-publication' | 'in-other-publication' | 'available';
  currentPublication: string | null;
}

interface ManageSubscriptionTablesProps {
  subscriptionId: string;
  subscriptionName: string;
  onClose: () => void;
  onUpdate: () => void;
}

export default function ManageSubscriptionTables({
  subscriptionId,
  subscriptionName,
  onClose,
  onUpdate
}: ManageSubscriptionTablesProps) {
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'in' | 'available' | 'other'>('all');
  const [search, setSearch] = useState('');
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAvailableTables();
  }, [subscriptionId]);

  const loadAvailableTables = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/subscriptions/${subscriptionId}/available-tables`);
      if (!res.ok) throw new Error('Failed to load tables');
      const data = await res.json();
      setTables(data.tables);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddTables = async () => {
    const tablesToAdd = Array.from(selectedTables);
    if (tablesToAdd.length === 0) {
      alert('Please select at least one table to add');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/subscriptions/${subscriptionId}/modify-tables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          tables: tablesToAdd
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to add tables');
      }

      alert(`Successfully added ${tablesToAdd.length} table(s) to ${subscriptionName}`);
      setSelectedTables(new Set());
      await loadAvailableTables();
      onUpdate();
    } catch (err: any) {
      setError(err.message);
      alert('Error: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveTables = async () => {
    const tablesToRemove = Array.from(selectedTables);
    if (tablesToRemove.length === 0) {
      alert('Please select at least one table to remove');
      return;
    }

    if (!confirm(`Are you sure you want to remove ${tablesToRemove.length} table(s) from ${subscriptionName}?`)) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/subscriptions/${subscriptionId}/modify-tables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'remove',
          tables: tablesToRemove
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to remove tables');
      }

      alert(`Successfully removed ${tablesToRemove.length} table(s) from ${subscriptionName}`);
      setSelectedTables(new Set());
      await loadAvailableTables();
      onUpdate();
    } catch (err: any) {
      setError(err.message);
      alert('Error: ' + err.message);
    } finally {
      setSubmitting(false);
    }
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

  const filteredTables = tables.filter(table => {
    if (filter === 'in' && table.status !== 'in-publication') return false;
    if (filter === 'available' && table.status !== 'available') return false;
    if (filter === 'other' && table.status !== 'in-other-publication') return false;
    if (search && !table.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const summary = {
    total: tables.length,
    inPublication: tables.filter(t => t.status === 'in-publication').length,
    available: tables.filter(t => t.status === 'available').length,
    inOther: tables.filter(t => t.status === 'in-other-publication').length
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Manage Tables</h2>
            <p className="text-sm text-gray-600 mt-1">{subscriptionName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
          >
            ×
          </button>
        </div>

        {/* Summary */}
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <div className="grid grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-gray-600">Total Tables</div>
              <div className="text-2xl font-bold">{summary.total}</div>
            </div>
            <div>
              <div className="text-gray-600">In Publication</div>
              <div className="text-2xl font-bold text-green-600">{summary.inPublication}</div>
            </div>
            <div>
              <div className="text-gray-600">Available</div>
              <div className="text-2xl font-bold text-blue-600">{summary.available}</div>
            </div>
            <div>
              <div className="text-gray-600">In Other</div>
              <div className="text-2xl font-bold text-orange-600">{summary.inOther}</div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="px-6 py-4 border-b border-gray-200 space-y-3">
          <div className="flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1 rounded ${filter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              All ({tables.length})
            </button>
            <button
              onClick={() => setFilter('in')}
              className={`px-3 py-1 rounded ${filter === 'in' ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              In Publication ({summary.inPublication})
            </button>
            <button
              onClick={() => setFilter('available')}
              className={`px-3 py-1 rounded ${filter === 'available' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              Available ({summary.available})
            </button>
            <button
              onClick={() => setFilter('other')}
              className={`px-3 py-1 rounded ${filter === 'other' ? 'bg-orange-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              In Other ({summary.inOther})
            </button>
          </div>
          <input
            type="text"
            placeholder="Search tables..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded"
          />
        </div>

        {/* Table List */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="text-center py-8 text-gray-600">Loading tables...</div>
          ) : error ? (
            <div className="text-center py-8 text-red-600">Error: {error}</div>
          ) : filteredTables.length === 0 ? (
            <div className="text-center py-8 text-gray-600">No tables found</div>
          ) : (
            <div className="space-y-2">
              {filteredTables.map(table => (
                <div
                  key={table.name}
                  className={`p-3 border rounded cursor-pointer hover:bg-gray-50 ${
                    selectedTables.has(table.name) ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                  }`}
                  onClick={() => {
                    if (table.status !== 'in-other-publication') {
                      toggleTable(table.name);
                    }
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <input
                        type="checkbox"
                        checked={selectedTables.has(table.name)}
                        disabled={table.status === 'in-other-publication'}
                        onChange={() => toggleTable(table.name)}
                        className="w-4 h-4"
                      />
                      <div className="flex-1">
                        <div className="font-mono text-sm font-medium">{table.name}</div>
                        <div className="text-xs text-gray-500">{table.size}</div>
                      </div>
                    </div>
                    <div>
                      {table.status === 'in-publication' && (
                        <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">
                          In This Publication
                        </span>
                      )}
                      {table.status === 'available' && (
                        <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                          Available
                        </span>
                      )}
                      {table.status === 'in-other-publication' && (
                        <span className="px-2 py-1 bg-orange-100 text-orange-800 text-xs rounded">
                          In {table.currentPublication}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-between items-center">
          <div className="text-sm text-gray-600">
            {selectedTables.size} table(s) selected
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              onClick={handleRemoveTables}
              disabled={submitting || selectedTables.size === 0 || Array.from(selectedTables).every(t => tables.find(tb => tb.name === t)?.status !== 'in-publication')}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {submitting ? 'Removing...' : 'Remove from Publication'}
            </button>
            <button
              onClick={handleAddTables}
              disabled={submitting || selectedTables.size === 0 || Array.from(selectedTables).every(t => tables.find(tb => tb.name === t)?.status !== 'available')}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {submitting ? 'Adding...' : 'Add to Publication'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
