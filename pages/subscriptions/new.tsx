import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Navbar from '@/components/Navbar';

export default function NewSubscription() {
  const router = useRouter();
  const [allTables, setAllTables] = useState<string[]>([]);
  const [tableInfo, setTableInfo] = useState<Array<{
    tableName: string;
    table: string;
    sourceRowCount: number;
    sourceSize: number;
    writersOnSource?: string[];
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [excludeMode, setExcludeMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPasteList, setShowPasteList] = useState(false);
  const [pasteListText, setPasteListText] = useState('');
  const [sortColumn, setSortColumn] = useState<'table' | 'rows' | 'size' | 'writers'>('table');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dataCopy, setDataCopy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useExistingPublication, setUseExistingPublication] = useState(false);
  const [existingPublications, setExistingPublications] = useState<Array<{ name: string; tables: string[]; tableCount: number }>>([]);
  const [selectedPublications, setSelectedPublications] = useState<string[]>([]); // Support multiple publications
  const [selectedTablesFromPub, setSelectedTablesFromPub] = useState<Set<string>>(new Set()); // Selected tables from publications
  const [showPasteListPub, setShowPasteListPub] = useState(false);
  const [pasteListTextPub, setPasteListTextPub] = useState('');
  const [loadingPublications, setLoadingPublications] = useState(false);

  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualSlotName, setManualSlotName] = useState('');
  const [manualPublicationName, setManualPublicationName] = useState('');


  useEffect(() => {
    loadTables();
    loadPublications();
  }, []);

  // Auto-detect backup slot from publication name
  useEffect(() => {
    if (selectedPublications.length === 1) {
      const pubName = selectedPublications[0];
      // Check if it matches backup_pub_{timestamp} pattern
      const match = pubName.match(/^backup_pub_(\d+)$/);
      if (match) {
        const timestamp = match[1];
        const suggestedSlot = `backup_slot_${timestamp}`;
        setManualSlotName(suggestedSlot);
        setShowAdvanced(true);
      }
    }
  }, [selectedPublications]);

  const loadPublications = async () => {
    try {
      setLoadingPublications(true);
      const res = await fetch('/api/publications/list');
      if (res.ok) {
        const data = await res.json();
        setExistingPublications(data.publications || []);
      }
    } catch (err) {
      console.error('Error loading publications:', err);
    } finally {
      setLoadingPublications(false);
    }
  };

  useEffect(() => {
    // Check if tables are pre-selected from query params
    if (router.query.tables) {
      const preSelectedTables = (router.query.tables as string).split(',').filter(Boolean);
      if (preSelectedTables.length > 0) {
        setSelectedTables(preSelectedTables);
        // Pre-fill name if not set
        if (preSelectedTables.length > 0) {
          setName(prev => prev || `Subscription for ${preSelectedTables.length} table${preSelectedTables.length !== 1 ? 's' : ''}`);
        }
      }
    }
  }, [router.query.tables]);

  const loadTables = async () => {
    try {
      const res = await fetch('/api/tables/all');
      const data = await res.json();
      const tables = (data.tables || []).map((t: any) => t.table || t.tableName).filter(Boolean);
      setAllTables(tables);

      // Store full table info for display
      const fullTableInfo = (data.tables || []).map((t: any) => ({
        tableName: t.tableName || t.table,
        table: t.table || t.tableName,
        sourceRowCount: t.sourceRowCount || 0,
        sourceSize: t.sourceSize || 0,
        writersOnSource: t.writersOnSource || [],
      }));
      setTableInfo(fullTableInfo);

      setLoading(false);
    } catch (err: any) {
      console.error('Error loading tables:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  const toggleTable = (table: string) => {
    setSelectedTables(prev =>
      prev.includes(table)
        ? prev.filter(t => t !== table)
        : [...prev, table]
    );
  };

  // Format helpers
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const formatNumber = (num: number) => {
    if (num < 1000) return num.toString();
    if (num < 1000000) return `${(num / 1000).toFixed(1)}k`;
    return `${(num / 1000000).toFixed(1)}M`;
  };

  const getWriterCount = (writers?: string[]) => {
    return writers?.length || 0;
  };

  // Parse table list from text (handles newlines, spaces, commas)
  const parseTableList = (text: string): string[] => {
    if (!text.trim()) return [];
    const parts = text
      .split(/[\n,\s]+/)
      .map(part => part.trim())
      .filter(part => part.length > 0);
    return parts;
  };

  // Normalize table name for matching
  const normalizeTableName = (name: string): string => {
    const cleaned = name
      .trim()
      .replace(/^public\./i, '')
      .replace(/^["'`]/, '')
      .replace(/["'`]$/, '');

    return cleaned
      .replace(/[\s._-]+/g, '')
      .toLowerCase();
  };

  // Load tables from pasted text
  const loadTablesFromPaste = () => {
    const parsedNames = parseTableList(pasteListText);
    if (parsedNames.length === 0) {
      alert('No table names found in the pasted text');
      return;
    }

    const matchedTables: string[] = [];
    const notFound: string[] = [];

    parsedNames.forEach(parsedName => {
      const normalizedParsed = normalizeTableName(parsedName);

      // Try to find matching table
      const found = tableInfo.find(table => {
        const normalizedTable = normalizeTableName(table.table);
        const normalizedTableName = normalizeTableName(table.tableName);
        return normalizedTable === normalizedParsed || normalizedTableName === normalizedParsed;
      });

      if (found && !matchedTables.includes(found.table)) {
        matchedTables.push(found.table);
      } else if (!found) {
        notFound.push(parsedName);
      }
    });

    if (matchedTables.length > 0) {
      setSelectedTables(matchedTables);
      setPasteListText('');
      setShowPasteList(false);

      if (notFound.length > 0) {
        alert(`Loaded ${matchedTables.length} table(s). ${notFound.length} table(s) not found: ${notFound.slice(0, 10).join(', ')}${notFound.length > 10 ? '...' : ''}`);
      } else {
        alert(`Successfully loaded ${matchedTables.length} table(s)`);
      }
    } else {
      alert(`No matching tables found. Please check the table names.\n\nNot found: ${notFound.slice(0, 10).join(', ')}${notFound.length > 10 ? '...' : ''}`);
    }
  };

  // Filter and sort tables
  const filteredTables = tableInfo.filter(table =>
    table.table.toLowerCase().includes(searchQuery.toLowerCase()) ||
    table.tableName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sortedTables = [...filteredTables].sort((a, b) => {
    let comparison = 0;
    switch (sortColumn) {
      case 'table':
        comparison = a.table.localeCompare(b.table);
        break;
      case 'rows':
        comparison = a.sourceRowCount - b.sourceRowCount;
        break;
      case 'size':
        comparison = a.sourceSize - b.sourceSize;
        break;
      case 'writers':
        comparison = getWriterCount(a.writersOnSource) - getWriterCount(b.writersOnSource);
        break;
    }
    return sortDirection === 'asc' ? comparison : -comparison;
  });

  const handleSort = (column: typeof sortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const SortIcon = ({ column }: { column: typeof sortColumn }) => {
    if (sortColumn !== column) return <span className="text-gray-400">↕</span>;
    return sortDirection === 'asc' ? <span>↑</span> : <span>↓</span>;
  };

  // Load tables from pasted text for publication selection
  const loadTablesFromPastePub = () => {
    const parsedNames = parseTableList(pasteListTextPub);
    if (parsedNames.length === 0) {
      alert('No table names found in the pasted text');
      return;
    }

    const matchedTables = new Set<string>();
    const notFound: string[] = [];

    // Get all tables from selected publications
    const allPubTables = selectedPublications.flatMap(pubName => {
      const pub = existingPublications.find(p => p.name === pubName);
      return pub?.tables || [];
    });

    parsedNames.forEach(parsedName => {
      const normalizedParsed = normalizeTableName(parsedName);

      // Try to find matching table in selected publications
      const found = allPubTables.find(table => {
        const normalizedTable = normalizeTableName(table);
        return normalizedTable === normalizedParsed;
      });

      if (found) {
        matchedTables.add(found);
      } else {
        notFound.push(parsedName);
      }
    });

    if (matchedTables.size > 0) {
      setSelectedTablesFromPub(matchedTables);
      setPasteListTextPub('');
      setShowPasteListPub(false);

      if (notFound.length > 0) {
        alert(`Loaded ${matchedTables.size} table(s). ${notFound.length} table(s) not found: ${notFound.slice(0, 10).join(', ')}${notFound.length > 10 ? '...' : ''}`);
      } else {
        alert(`Successfully loaded ${matchedTables.size} table(s)`);
      }
    } else {
      alert(`No matching tables found in selected publications. Please check the table names.\n\nNot found: ${notFound.slice(0, 10).join(', ')}${notFound.length > 10 ? '...' : ''}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreating(true);

    // Validate table selection
    if (!useExistingPublication) {
      if (!excludeMode && selectedTables.length === 0) {
        setError('Please select at least one table to include');
        setCreating(false);
        return;
      }
      if (excludeMode && selectedTables.length === 0) {
        setError('Please select at least one table to exclude');
        setCreating(false);
        return;
      }
    }

    try {
      const res = await fetch('/api/subscriptions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          customTables: useExistingPublication
            ? Array.from(selectedTablesFromPub)
            : (!excludeMode ? selectedTables : undefined),
          excludeTables: useExistingPublication
            ? undefined
            : (excludeMode ? selectedTables : undefined),
          dataCopy,
          useExistingPublication,
          existingPublicationNames: useExistingPublication ? selectedPublications : undefined,
          slotName: manualSlotName.trim() || undefined,
          publicationName: manualPublicationName.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        // Show detailed error message if available
        let errorMsg = data.error || 'Failed to create subscription';

        if (data.details) {
          errorMsg += `\n\n${data.details}`;
        }

        if (data.hint) {
          errorMsg += `\n\n💡 ${data.hint}`;
        }

        if (data.workflow && Array.isArray(data.workflow)) {
          errorMsg += `\n\n📋 Recommended Workflow:\n${data.workflow.map((step: string, i: number) => `   ${step}`).join('\n')}`;
        }

        if (data.missingTables && Array.isArray(data.missingTables)) {
          errorMsg += `\n\n❌ Missing Tables (${data.missingTables.length}):\n   ${data.missingTables.slice(0, 10).join(', ')}${data.missingTables.length > 10 ? ` ... and ${data.missingTables.length - 10} more` : ''}`;
        }

        throw new Error(errorMsg);
      }

      // Redirect to subscription details
      router.push(`/subscriptions/${data.id}`);
    } catch (err: any) {
      setError(err.message);
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Link href="/" className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
            ← Back to Dashboard
          </Link>

          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Create New Subscription</h1>
            <p className="mt-2 text-gray-600">
              Create a new replication subscription by selecting tables to replicate
            </p>
          </div>

          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="text-red-800 font-medium">Error</div>
              <div className="text-red-600 mt-1">{error}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Subscription Details */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">
                1. Subscription Details
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name *
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g., My Subscription"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Description of this subscription"
                  />
                </div>
              </div>
            </div>

            {/* Publication Selection */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">
                2. Publication
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="publicationMode"
                      checked={!useExistingPublication}
                      onChange={() => {
                        setUseExistingPublication(false);
                        setSelectedPublications([]);
                        setSelectedTablesFromPub(new Set());
                      }}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      Create new publication
                    </span>
                  </label>
                  <p className="text-xs text-gray-500 ml-6 mt-1">
                    A new publication will be created based on your subscription name and selected tables.
                  </p>
                </div>
                <div>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="publicationMode"
                      checked={useExistingPublication}
                      onChange={() => setUseExistingPublication(true)}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      Use existing publication
                    </span>
                  </label>
                  <p className="text-xs text-gray-500 ml-6 mt-1">
                    Select an existing publication that was created previously.
                  </p>
                </div>

                {useExistingPublication && (
                  <div className="ml-6 mt-4 space-y-4">
                    {loadingPublications ? (
                      <div className="text-sm text-gray-500">Loading publications...</div>
                    ) : existingPublications.length === 0 ? (
                      <div className="text-sm text-gray-500">
                        No publications found. <Link href="/publications" className="text-blue-600 hover:text-blue-800">Create one</Link>
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Select Publications (you can select multiple):
                          </label>
                          <div className="space-y-2 max-h-48 overflow-y-auto border border-gray-200 rounded p-2">
                            {existingPublications.map((pub) => (
                              <label
                                key={pub.name}
                                className="flex items-start p-2 rounded hover:bg-gray-50 cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedPublications.includes(pub.name)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedPublications([...selectedPublications, pub.name]);
                                      // Auto-select all tables from this publication
                                      const pubTables = pub.tables || [];
                                      setSelectedTablesFromPub(new Set([...selectedTablesFromPub, ...pubTables]));
                                    } else {
                                      setSelectedPublications(selectedPublications.filter(p => p !== pub.name));
                                      // Remove tables from this publication
                                      const pubTables = pub.tables || [];
                                      const newSet = new Set(selectedTablesFromPub);
                                      pubTables.forEach(t => newSet.delete(t));
                                      setSelectedTablesFromPub(newSet);
                                    }
                                  }}
                                  className="mt-1 mr-2"
                                />
                                <div className="flex-1">
                                  <span className="text-sm font-medium text-gray-900 font-mono">{pub.name}</span>
                                  <span className="text-xs text-gray-500 ml-2">
                                    ({pub.tableCount} table{pub.tableCount !== 1 ? 's' : ''})
                                  </span>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>

                        {selectedPublications.length > 0 && (
                          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
                            <div className="text-sm font-medium text-gray-900 mb-3">
                              Select Tables from Selected Publications ({selectedTablesFromPub.size} selected):
                            </div>
                            <div className="mb-2 space-y-2">
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={searchQuery}
                                  onChange={(e) => setSearchQuery(e.target.value)}
                                  placeholder="Search tables..."
                                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                                />
                                <button
                                  type="button"
                                  onClick={() => setShowPasteListPub(!showPasteListPub)}
                                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                                >
                                  {showPasteListPub ? '✕ Hide' : '📋 Paste List'}
                                </button>
                              </div>

                              {showPasteListPub && (
                                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                                  <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Paste table names (one per line, or comma/space separated):
                                  </label>
                                  <textarea
                                    value={pasteListTextPub}
                                    onChange={(e) => setPasteListTextPub(e.target.value)}
                                    placeholder={`AccountBalanceSeries\nAccountCollateralBalanceSeries\nAccountTotalBalanceSeries\n...`}
                                    rows={6}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                                  />
                                  <div className="mt-2 flex gap-2">
                                    <button
                                      type="button"
                                      onClick={loadTablesFromPastePub}
                                      className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
                                    >
                                      Load Tables
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setPasteListTextPub('');
                                        setShowPasteListPub(false);
                                      }}
                                      className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                                    >
                                      Clear
                                    </button>
                                  </div>
                                  <p className="mt-2 text-xs text-gray-500">
                                    Supports newline, comma, or space-separated table names. Will match against tables in selected publications.
                                  </p>
                                </div>
                              )}
                            </div>
                            <div className="mb-2 flex gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  // Select all tables from selected publications
                                  const allTables = selectedPublications.flatMap(pubName => {
                                    const pub = existingPublications.find(p => p.name === pubName);
                                    return pub?.tables || [];
                                  });
                                  setSelectedTablesFromPub(new Set(allTables));
                                }}
                                className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                              >
                                Select All
                              </button>
                              <button
                                type="button"
                                onClick={() => setSelectedTablesFromPub(new Set())}
                                className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                              >
                                Clear All
                              </button>
                            </div>
                            <div className="max-h-64 overflow-y-auto border border-gray-200 rounded p-2 bg-white">
                              {selectedPublications.flatMap(pubName => {
                                const pub = existingPublications.find(p => p.name === pubName);
                                if (!pub) return [];
                                const filtered = pub.tables.filter(t =>
                                  t.toLowerCase().includes(searchQuery.toLowerCase())
                                );
                                return filtered.map(table => (
                                  <label
                                    key={`${pubName}-${table}`}
                                    className="flex items-center p-1 rounded hover:bg-gray-50 cursor-pointer"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedTablesFromPub.has(table)}
                                      onChange={(e) => {
                                        const newSet = new Set(selectedTablesFromPub);
                                        if (e.target.checked) {
                                          newSet.add(table);
                                        } else {
                                          newSet.delete(table);
                                        }
                                        setSelectedTablesFromPub(newSet);
                                      }}
                                      className="mr-2"
                                    />
                                    <span className="text-xs font-mono text-gray-700">{table}</span>
                                    <span className="text-xs text-gray-400 ml-2">({pubName})</span>
                                  </label>
                                ));
                              })}
                              {selectedPublications.flatMap(pubName => {
                                const pub = existingPublications.find(p => p.name === pubName);
                                return pub?.tables || [];
                              }).filter(t => t.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 && (
                                  <div className="text-center py-4 text-gray-500 text-sm">No tables found</div>
                                )}
                            </div>
                            <p className="mt-2 text-xs text-gray-500">
                              You can select a subset of tables from the selected publications. Only selected tables will be replicated.
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Table Selection - Only show if creating new publication */}
            {!useExistingPublication && (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  3. Select Tables ({selectedTables.length} {excludeMode ? 'excluded' : 'selected'})
                </h2>

                {/* Exclude Mode Toggle */}
                <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <label className="flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={excludeMode}
                      onChange={(e) => {
                        setExcludeMode(e.target.checked);
                        // Clear selection when switching modes
                        setSelectedTables([]);
                      }}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm font-medium text-gray-700">
                      Exclude mode (replicate all tables except selected)
                    </span>
                  </label>
                  <p className="mt-1 ml-6 text-xs text-gray-500">
                    When enabled, all tables will be replicated except the ones you select. Useful when you want to replicate most tables but exclude a few.
                  </p>
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
                      type="button"
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
                          type="button"
                          onClick={loadTablesFromPaste}
                          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
                        >
                          Load Tables
                        </button>
                        <button
                          type="button"
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
                        {excludeMode && ' Tables you paste will be excluded from replication.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* Table Selection Controls */}
                <div className="mb-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedTables(sortedTables.map(t => t.table))}
                    className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
                  >
                    Select All
                  </button>
                  {selectedTables.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedTables([])}
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
                              checked={sortedTables.length > 0 && sortedTables.every(t => selectedTables.includes(t.table))}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedTables(sortedTables.map(t => t.table));
                                } else {
                                  setSelectedTables([]);
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
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {loading ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                              Loading tables...
                            </td>
                          </tr>
                        ) : sortedTables.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                              No tables found
                            </td>
                          </tr>
                        ) : (
                          sortedTables.map((table) => (
                            <tr
                              key={table.tableName}
                              className={`hover:bg-gray-50 cursor-pointer ${selectedTables.includes(table.table) ? 'bg-blue-50' : ''
                                }`}
                              onClick={() => toggleTable(table.table)}
                            >
                              <td className="px-4 py-2">
                                <input
                                  type="checkbox"
                                  checked={selectedTables.includes(table.table)}
                                  onChange={() => toggleTable(table.table)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                              </td>
                              <td className="px-4 py-2 text-sm font-mono text-gray-900">
                                {table.table}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-600 text-right">
                                {formatNumber(table.sourceRowCount)}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-600 text-right">
                                {formatBytes(table.sourceSize)}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-600">
                                {getWriterCount(table.writersOnSource)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* Baseline Backup Warning */}
            <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-4 mb-6">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-yellow-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="ml-3 flex-1">
                  <h3 className="text-sm font-medium text-yellow-800">
                    ⚠️ Baseline Backup Required
                  </h3>
                  <div className="mt-2 text-sm text-yellow-700">
                    <p className="mb-2">
                      <strong>Before creating a subscription, you must restore a baseline backup to the target database.</strong>
                    </p>
                    <p className="mb-2">This ensures:</p>
                    <ul className="list-disc list-inside ml-2 space-y-1">
                      <li>Tables exist on target (schema + data)</li>
                      <li>Target has the same initial state as source at backup point</li>
                      <li>Subscription can start replicating changes from the correct LSN</li>
                    </ul>
                    <p className="mt-3 font-medium">Recommended Workflow:</p>
                    <ol className="list-decimal list-inside ml-2 space-y-1 mt-1">
                      <li>Create backup from source (with replication slot if needed)</li>
                      <li>Restore the backup to target database</li>
                      <li>Create subscription with <code className="bg-yellow-100 px-1 rounded">copy_data = false</code> (data already copied)</li>
                    </ol>
                    <p className="mt-3">
                      <Link href="/backup" className="text-yellow-800 underline font-medium">
                        Go to Backup & Restore →
                      </Link>
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Data Copy Option */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">
                {useExistingPublication ? '3. Replication Settings' : '4. Replication Settings'}
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={dataCopy}
                      onChange={(e) => setDataCopy(e.target.checked)}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      Copy existing data (copy_data = true)
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500 ml-6">
                    {dataCopy ? (
                      <>
                        <strong>Enabled:</strong> PostgreSQL will copy existing data from source to target during subscription creation.
                        <span className="block mt-1 text-yellow-700">
                          ⚠️ Only use this if you haven&apos;t restored a baseline backup. If you&apos;ve already restored a backup, keep this disabled.
                        </span>
                      </>
                    ) : (
                      <>
                        <strong>Disabled (Recommended):</strong> Only new changes will be replicated. Use this when you&apos;ve already restored a baseline backup to the target.
                      </>
                    )}
                  </p>
                  <div className="mt-2 ml-6">
                    <span className={`inline-block px-2 py-1 text-xs rounded ${dataCopy
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-100 text-gray-800'
                      }`}>
                      data_copy = {dataCopy ? 'true' : 'false'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Advanced Options */}
            <div className="bg-white rounded-lg shadow p-6">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center text-lg font-semibold text-gray-900 w-full text-left focus:outline-none"
              >
                <span className="mr-2">{showAdvanced ? '▼' : '▶'}</span>
                4. Advanced Options
              </button>

              {showAdvanced && (
                <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
                  <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 mb-4">
                    <p className="text-sm text-yellow-800">
                      <strong>Warning:</strong> These settings are for advanced use cases only.
                      Incorrectly setting these values may cause replication failures or data loss.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Existing Replication Slot Name (Optional)
                    </label>
                    <input
                      type="text"
                      value={manualSlotName}
                      onChange={(e) => setManualSlotName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                      placeholder="e.g., backup_slot_123456789"
                    />
                    {manualSlotName.startsWith('backup_slot_') ? (
                      <p className="mt-1 text-xs text-green-600 font-medium">
                        ✅ Backup slot detected. Replication will resume exactly from the backup point (zero data loss).
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-gray-500">
                        If you created a consistent backup with a replication slot, enter that slot name here.
                        This ensures zero data loss by resuming replication exactly from the backup point.
                      </p>
                    )}
                  </div>

                  {!useExistingPublication && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Custom Publication Name (Optional)
                      </label>
                      <input
                        type="text"
                        value={manualPublicationName}
                        onChange={(e) => setManualPublicationName(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                        placeholder="e.g., my_custom_publication"
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        Override the automatically generated publication name.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Submit */}
            <div className="flex justify-end gap-4">
              <Link
                href="/"
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={creating || (!useExistingPublication && selectedTables.length === 0) || (useExistingPublication && (selectedPublications.length === 0 || selectedTablesFromPub.size === 0)) || !name}
                className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {creating ? 'Creating...' : 'Create Subscription'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

