import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Navbar from '@/components/Navbar';

interface TableInfo {
  tableName: string; // Full name: schema.table
  schema: string;
  table: string; // Just the table name
  sourceRowCount: number;
  sourceSize: number;
}

interface BackupInfo {
  filename: string;
  filepath: string;
  size: number;
  created: string;
  modified: string;
}

interface BackupTaskInfo {
  id: string;
  task_type: 'backup' | 'restore';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stalled';
  filename?: string;
  filepath?: string;
  file_size?: number;
  tables?: string[];
  exclude_tables?: string[];
  snapshot_id?: string;
  slot_name?: string;
  publication_name?: string;
  slot_initial_lsn?: string;
  schema_only?: boolean;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

export default function BackupPage() {
  const router = useRouter();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupTasks, setBackupTasks] = useState<BackupTaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingBackups, setLoadingBackups] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [excludeMode, setExcludeMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [enableReplication, setEnableReplication] = useState(true); // Enable replication by default
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState<{ [key: string]: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [backupProgress, setBackupProgress] = useState<{
    step: string;
    status: 'pending' | 'running' | 'completed' | 'error';
    details?: string;
    fileSize?: number;
    estimatedSize?: number;
    taskId?: string;
  } | null>(null);
  
  // Exclude tables text input
  const [excludeTablesText, setExcludeTablesText] = useState('');
  const [showExcludeTextInput, setShowExcludeTextInput] = useState(false);
  
  // Poll for backup progress
  const [progressInterval, setProgressInterval] = useState<NodeJS.Timeout | null>(null);

  // Common exclude tables list (preset)
  const COMMON_EXCLUDE_TABLES = `public."AccountBalanceSeries"
public."AccountCollateralBalanceSeries"
public."AccountTotalBalanceSeries"
public."Candle"
public."DiscordRankUpdaterHelper"
public."EmbeddedWallets"
public."EndOfSeasonData"
public."FundingRateSeries"
public."LatestXpLeaderboardSnapshots"
public."LatestXpLeaderboardSnapshotsV5"
public."LatestXpLeaderboardV3"
public."LeaderBoardsTempSep192025"
public."LiquidityXpV4"
public."LiquidityXpV5"
public."LpPoolAddressPerformanceSeries"
public."OwnerAddressTotalBalanceSeries"
public."Passkeys"
public."PointsLeaderBoards_backup"
public."PointsXpOpenInterestSnapshots"
public."PointsXpStakingSnapshots"
public."PositionSeries"
public."PriceFeedMonitoring"
public."RandomBoost"
public."SpotCandle"
public."StorkPriceUpdates"
public."TraderActivitySnapshots"
public."TradingInstantBoostV4"
public."TrmRiskResult"
public."WalletMarketPreference"
public."XpUserV3"
public."XpV3LeaderboardSnapshot"
public.account_collateral_balance_entries
public.account_collateral_net_balance
public.account_owner_updated_history
public.account_owner_updated_snapshot
public.asset_price_history
public.asset_price_interval
public.auto_exchange_configrations
public.margin_accounts_balance_entries
public.market_trackers_history
public.market_trackers_interval
public.market_volatility_configuration_history
public.order_history
public.order_off_chain_trackers
public.orders_migration
public.pool_price_history
public.pool_price_snapshot
public.positions_migration
public.rebalancing_discount
public.rebate_fee_history
public.spot_price_history
public.stork_asset_price_history
public.trading_stats_account_market
public.trading_stats_wallet`;

  const loadPresetExcludeTables = () => {
    setExcludeTablesText(COMMON_EXCLUDE_TABLES);
    setShowExcludeTextInput(true);
  };

  useEffect(() => {
    loadTables();
    loadBackups();
    loadBackupTasks();
  }, []);

  useEffect(() => {
    // Refresh tasks every 5 seconds if there are running tasks
    const interval = setInterval(() => {
      const hasRunningTasks = backupTasks.some(t => t.status === 'running' || t.status === 'pending');
      if (hasRunningTasks) {
        loadBackupTasks();
      }
    }, 5000);

    // Check for stalled tasks every 2 minutes
    const stalledCheckInterval = setInterval(() => {
      const hasRunningTasks = backupTasks.some(t => t.status === 'running');
      if (hasRunningTasks) {
        fetch('/api/backup/check-stalled', { method: 'POST' })
          .then(() => loadBackupTasks())
          .catch(err => console.error('Error checking for stalled tasks:', err));
      }
    }, 2 * 60 * 1000); // Every 2 minutes

    return () => {
      clearInterval(interval);
      clearInterval(stalledCheckInterval);
    };
  }, [backupTasks]);
  
  useEffect(() => {
    // Cleanup interval on unmount
    return () => {
      if (progressInterval) {
        clearInterval(progressInterval);
      }
    };
  }, [progressInterval]);
  
  // Poll for backup progress
  const pollBackupProgress = async (taskId: string) => {
    try {
      const res = await fetch(`/api/backup/tasks/${taskId}`);
      if (res.ok) {
        const data = await res.json();
        const task = data.task;
        
        if (task.status === 'running' && task.filepath) {
          // Try to get current file size
          try {
            const fileRes = await fetch(`/api/backup/tasks/${taskId}/file-size`);
            if (fileRes.ok) {
              const fileData = await fileRes.json();
              setBackupProgress(prev => ({
                ...prev!,
                fileSize: fileData.fileSize,
                step: `Backing up... ${formatBytes(fileData.fileSize || 0)}`,
                status: 'running',
              }));
            }
          } catch (err) {
            // Ignore file size errors, use task file_size if available
          }
          
          if (task.file_size) {
            setBackupProgress(prev => ({
              ...prev!,
              fileSize: task.file_size,
              step: `Backing up... ${formatBytes(task.file_size)}`,
              status: 'running',
            }));
          }
        } else if (task.status === 'completed') {
          setBackupProgress({
            step: 'Backup completed',
            status: 'completed',
            fileSize: task.file_size,
            details: task.filename ? `File: ${task.filename} (${formatBytes(task.file_size || 0)})` : undefined,
          });
          if (progressInterval) {
            clearInterval(progressInterval);
            setProgressInterval(null);
          }
          await loadBackups();
          await loadBackupTasks();
        } else if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'stalled') {
          setBackupProgress({
            step: task.status === 'cancelled' ? 'Backup cancelled' : task.status === 'stalled' ? 'Backup stalled' : 'Backup failed',
            status: 'error',
            details: task.error_message || 'Unknown error',
          });
          if (progressInterval) {
            clearInterval(progressInterval);
            setProgressInterval(null);
          }
          await loadBackupTasks();
        }
      }
    } catch (err) {
      console.error('Error polling backup progress:', err);
    }
  };

  useEffect(() => {
    if (router.query.tables) {
      const preSelectedTables = (router.query.tables as string).split(',').filter(Boolean);
      if (preSelectedTables.length > 0) {
        setSelectedTables(new Set(preSelectedTables));
      }
    }
  }, [router.query.tables]);

  const loadTables = async () => {
    try {
      const res = await fetch('/api/tables/all');
      if (res.ok) {
        const data = await res.json();
        setTables(data.tables || []);
      }
    } catch (err: any) {
      console.error('Error loading tables:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadBackups = async () => {
    try {
      setLoadingBackups(true);
      const res = await fetch('/api/backup/list');
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch (err: any) {
      console.error('Error loading backups:', err);
    } finally {
      setLoadingBackups(false);
    }
  };

  const loadBackupTasks = async () => {
    try {
      setLoadingTasks(true);
      const res = await fetch('/api/backup/tasks?task_type=backup&limit=50');
      if (res.ok) {
        const data = await res.json();
        setBackupTasks(data.tasks || []);
      }
    } catch (err: any) {
      console.error('Error loading backup tasks:', err);
    } finally {
      setLoadingTasks(false);
    }
  };

  const handleCancelTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to cancel this backup task?')) {
      return;
    }

    try {
      const res = await fetch(`/api/backup/tasks/${taskId}`, {
        method: 'POST',
      });
      if (res.ok) {
        setSuccess('Backup task cancelled successfully');
        loadBackupTasks();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cancel task');
      }
    } catch (err: any) {
      setError('Failed to cancel task: ' + err.message);
    }
  };

  const handleDeleteTask = async (taskId: string, hasFile: boolean) => {
    const message = hasFile
      ? 'Are you sure you want to delete this task? This will also delete the backup file.'
      : 'Are you sure you want to delete this task?';
    if (!confirm(message)) {
      return;
    }

    try {
      const res = await fetch(`/api/backup/tasks/${taskId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deleteFile: hasFile }),
      });
      if (res.ok) {
        setSuccess('Backup task deleted successfully');
        loadBackupTasks();
        loadBackups(); // Refresh backup list in case file was deleted
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete task');
      }
    } catch (err: any) {
      setError('Failed to delete task: ' + err.message);
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

  const selectAllFiltered = () => {
    const filtered = filteredTables.map(t => t.table);
    setSelectedTables(new Set(filtered));
  };

  const deselectAll = () => {
    setSelectedTables(new Set());
  };

  // Parse and load tables from text (newline or comma-separated)
  const loadTablesFromText = () => {
    if (!excludeTablesText.trim()) {
      setError('Please enter table names to exclude');
      return;
    }

    // Parse tables - support both newline and comma-separated
    const tableNames = excludeTablesText
      .split(/[,\n]/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        // Remove quotes if present
        return line.replace(/^["']|["']$/g, '');
      });

    if (tableNames.length === 0) {
      setError('No valid table names found in the text');
      return;
    }

    // Match table names to available tables
    const matchedTables = new Set<string>();
    const unmatchedTables: string[] = [];

    tableNames.forEach(tableName => {
      // Normalize input: remove quotes, handle schema prefix
      let normalizedInput = tableName.trim();
      
      // Remove surrounding quotes
      normalizedInput = normalizedInput.replace(/^["']|["']$/g, '');
      
      // Extract table name (remove schema prefix if present)
      const tableNameOnly = normalizedInput.replace(/^public\./, '').replace(/^[^.]*\./, '');
      
      // Try multiple matching strategies
      const table = tables.find(t => {
        const fullName = t.tableName.toLowerCase();
        const tableOnly = t.table.toLowerCase();
        const normalizedLower = normalizedInput.toLowerCase();
        const tableOnlyLower = tableNameOnly.toLowerCase();
        
        // Exact match with schema
        if (fullName === normalizedLower) return true;
        
        // Match without schema
        if (fullName === `public.${normalizedLower}`) return true;
        
        // Match table name only
        if (tableOnly === tableOnlyLower) return true;
        
        // Match with quotes in full name
        if (fullName === normalizedLower.replace(/"/g, '')) return true;
        
        // Match end of full name (schema.table)
        if (fullName.endsWith(`.${tableOnlyLower}`)) return true;
        
        return false;
      });

      if (table) {
        matchedTables.add(table.table);
      } else {
        unmatchedTables.push(tableName);
      }
    });

    if (matchedTables.size > 0) {
      setSelectedTables(matchedTables);
      setSuccess(`Loaded ${matchedTables.size} table${matchedTables.size !== 1 ? 's' : ''} from text${unmatchedTables.length > 0 ? ` (${unmatchedTables.length} not found)` : ''}`);
      if (unmatchedTables.length > 0) {
        console.warn('Unmatched tables:', unmatchedTables);
      }
      setExcludeTablesText(''); // Clear input after loading
      setShowExcludeTextInput(false);
    } else {
      setError(`No matching tables found. Unmatched: ${unmatchedTables.slice(0, 5).join(', ')}${unmatchedTables.length > 5 ? '...' : ''}`);
    }
  };

  const handleBackup = async () => {
    if (!excludeMode && selectedTables.size === 0) {
      setError('Please select at least one table to include');
      return;
    }
    if (excludeMode && selectedTables.size === 0) {
      setError('Please select at least one table to exclude');
      return;
    }

    try {
      setBackingUp(true);
      setError(null);
      setSuccess(null);
      setBackupProgress({ step: 'Preparing backup...', status: 'running' });

      // Convert selected table names to full tableName (schema.table) format
      const tableNames = Array.from(selectedTables).map(selectedTable => {
        const tableInfo = tables.find(t => t.table === selectedTable || t.tableName === selectedTable);
        if (tableInfo && tableInfo.tableName) {
          return tableInfo.tableName;
        }
        return selectedTable.includes('.') ? selectedTable : `public.${selectedTable}`;
      });

      const requestBody: any = {
        schemaOnly,
        enableReplication, // This will create publication and slot automatically
      };

      if (excludeMode) {
        requestBody.excludeTables = tableNames;
      } else {
        requestBody.tables = tableNames;
      }

      setBackupProgress({ 
        step: enableReplication ? 'Creating publication and replication slot...' : 'Creating backup task...', 
        status: 'running' 
      });

      const res = await fetch('/api/backup/create-with-slot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const data = await res.json();

      if (res.ok) {
        // Refresh backup tasks list
        loadBackupTasks();
        
        // Calculate estimated size from selected tables
        let estimatedSize = 0;
        if (!excludeMode && selectedTables.size > 0) {
          const selectedTableInfos = tables.filter(t => selectedTables.has(t.table));
          estimatedSize = selectedTableInfos.reduce((sum, t) => sum + (t.sourceSize || 0), 0);
        } else if (excludeMode) {
          const excludedTableInfos = tables.filter(t => selectedTables.has(t.table));
          const excludedSize = excludedTableInfos.reduce((sum, t) => sum + (t.sourceSize || 0), 0);
          const totalSize = tables.reduce((sum, t) => sum + (t.sourceSize || 0), 0);
          estimatedSize = totalSize - excludedSize;
        }
        
        if (data.taskId) {
          // Start polling for progress
          const interval = setInterval(() => {
            pollBackupProgress(data.taskId);
          }, 2000); // Poll every 2 seconds
          setProgressInterval(interval);
          
          setBackupProgress({
            step: 'Backup task created, starting backup...',
            status: 'running',
            taskId: data.taskId,
            estimatedSize: estimatedSize > 0 ? estimatedSize : undefined,
            details: enableReplication 
              ? `Publication: ${data.publicationName}, Slot: ${data.slotName}`
              : undefined
          });
          
          setSuccess(
            enableReplication
              ? `Backup task created. Publication and replication slot created. Backup in progress...`
              : `Backup task created. Backup in progress...`
          );
          
          // Initial poll after 1 second
          setTimeout(() => pollBackupProgress(data.taskId), 1000);
        } else {
          setBackupProgress({ step: 'Failed', status: 'error', details: data.error });
          setError(data.error || 'Failed to create backup');
        }
      } else {
        setBackupProgress({ step: 'Failed', status: 'error', details: data.error });
        setError(data.error || 'Failed to create backup');
      }
    } catch (err: any) {
      setBackupProgress({ step: 'Failed', status: 'error', details: err.message });
      setError(err.message || 'Failed to create backup');
    } finally {
      setBackingUp(false);
    }
  };

  const handleRestore = async (filename: string) => {
    if (!confirm(`Restore backup ${filename}? This will overwrite existing tables.`)) {
      return;
    }

    try {
      setRestoring(prev => ({ ...prev, [filename]: true }));
      setError(null);
      setSuccess(null);

      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename,
          dryRun: false,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        if (data.taskId) {
          setSuccess(`Restore task created (ID: ${data.taskId.substring(0, 8)}...). Restore in progress...`);
        } else {
          setSuccess(`Restore completed: ${filename}`);
        }
        await loadBackups();
      } else {
        setError(data.error || 'Failed to restore backup');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to restore backup');
    } finally {
      setRestoring(prev => ({ ...prev, [filename]: false }));
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const filteredTables = tables.filter(table =>
    table.table.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-6 sm:px-8 lg:px-12 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Backup & Restore</h1>
            <p className="mt-2 text-gray-600">
              Select tables to backup. Optionally enable replication to capture changes during backup.
            </p>
          </div>

          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="text-red-800 font-medium">Error</div>
              <div className="text-red-600 mt-1">{error}</div>
            </div>
          )}

          {success && (
            <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="text-green-800 font-medium">Success</div>
              <div className="text-green-600 mt-1">{success}</div>
            </div>
          )}

          {backupProgress && (
            <div className={`mb-6 border rounded-lg p-4 ${
              backupProgress.status === 'completed' ? 'bg-green-50 border-green-200' :
              backupProgress.status === 'error' ? 'bg-red-50 border-red-200' :
              'bg-blue-50 border-blue-200'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  {backupProgress.status === 'running' && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
                  )}
                  {backupProgress.status === 'completed' && (
                    <span className="text-green-600 mr-2">✓</span>
                  )}
                  {backupProgress.status === 'error' && (
                    <span className="text-red-600 mr-2">✗</span>
                  )}
                  <span className={`font-medium ${
                    backupProgress.status === 'completed' ? 'text-green-800' :
                    backupProgress.status === 'error' ? 'text-red-800' :
                    'text-blue-800'
                  }`}>
                    {backupProgress.step}
                  </span>
                </div>
                {backupProgress.fileSize !== undefined && (
                  <div className="text-sm font-mono text-gray-600">
                    {formatBytes(backupProgress.fileSize)}
                    {backupProgress.estimatedSize && backupProgress.estimatedSize > 0 && (
                      <span className="text-gray-400 ml-2">
                        / ~{formatBytes(backupProgress.estimatedSize)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {backupProgress.details && (
                <div className="mt-2 text-sm text-gray-600">{backupProgress.details}</div>
              )}
              {backupProgress.status === 'running' && backupProgress.fileSize && backupProgress.estimatedSize && backupProgress.estimatedSize > 0 && (
                <div className="mt-3">
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                      style={{ 
                        width: `${Math.min(100, (backupProgress.fileSize / backupProgress.estimatedSize) * 100)}%` 
                      }}
                    ></div>
                  </div>
                  <div className="mt-1 text-xs text-gray-500 text-right">
                    {Math.round((backupProgress.fileSize / backupProgress.estimatedSize) * 100)}% complete
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Backup Section */}
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Step 1: Select Tables ({selectedTables.size} {excludeMode ? 'excluded' : 'selected'})
            </h2>

            {/* Mode Toggle */}
            <div className="mb-4 p-3 bg-gray-50 rounded-lg">
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
              <p className="ml-6 mt-1 text-xs text-gray-500">
                {excludeMode 
                  ? 'All tables will be backed up except the ones you select below.'
                  : 'Only the selected tables will be backed up.'}
              </p>
              
              {excludeMode && (
                <div className="ml-6 mt-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setShowExcludeTextInput(!showExcludeTextInput)}
                      className="text-sm text-blue-600 hover:text-blue-700 flex items-center"
                    >
                      <span>{showExcludeTextInput ? '▼' : '▶'}</span>
                      <span className="ml-2">Load exclude tables from text</span>
                    </button>
                    <span className="text-gray-400">|</span>
                    <button
                      type="button"
                      onClick={loadPresetExcludeTables}
                      className="text-sm text-green-600 hover:text-green-700"
                    >
                      Load Common Exclude List ({COMMON_EXCLUDE_TABLES.split('\n').filter(l => l.trim()).length} tables)
                    </button>
                  </div>
                  
                  {showExcludeTextInput && (
                    <div className="mt-3 space-y-2">
                      <textarea
                        value={excludeTablesText}
                        onChange={(e) => setExcludeTablesText(e.target.value)}
                        placeholder='Paste table names here (one per line or comma-separated):&#10;public.&quot;AccountBalanceSeries&quot;&#10;public.&quot;Candle&quot;&#10;public.order_history'
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                        rows={8}
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={loadTablesFromText}
                          disabled={!excludeTablesText.trim()}
                          className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                          Load Tables
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setExcludeTablesText('');
                            setShowExcludeTextInput(false);
                          }}
                          className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="text-xs text-gray-500">
                        Supports both newline-separated and comma-separated formats. Table names can include schema prefix (e.g., &quot;public.table&quot; or just &quot;table&quot;).
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Backup Type Selection */}
            <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Backup Type</h3>
              
              <div className="space-y-3">
                <label className="flex items-start">
                  <input
                    type="radio"
                    name="backupType"
                    checked={schemaOnly}
                    onChange={(e) => {
                      setSchemaOnly(true);
                      setEnableReplication(false); // Schema-only doesn't use replication
                    }}
                    className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <div className="ml-3 flex-1">
                    <span className="text-sm font-medium text-gray-700">Schema Only</span>
                    <p className="text-xs text-gray-500 mt-1">
                      Backup table structures only (no data). No replication slot needed.
                    </p>
                  </div>
                </label>
                
                <label className="flex items-start">
                  <input
                    type="radio"
                    name="backupType"
                    checked={!schemaOnly}
                    onChange={(e) => setSchemaOnly(false)}
                    className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <div className="ml-3 flex-1">
                    <span className="text-sm font-medium text-gray-700">Full Backup (Data + Schema)</span>
                    <p className="text-xs text-gray-500 mt-1">
                      Backup both table structures and data. Can optionally enable replication to capture changes.
                    </p>
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
                    <div className="ml-2 flex-1">
                      <span className="text-sm font-medium text-gray-700">
                        Enable Replication Snapshot
                      </span>
                      <p className="text-xs text-gray-500 mt-1">
                        Creates a publication and replication slot before backup to capture changes during the backup process. 
                        This enables continuous replication after the initial backup.
                      </p>
                    </div>
                  </label>
                </div>
              )}
            </div>

            {/* Table Search and Selection */}
            <div className="mb-4">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tables..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="mb-4 flex gap-2">
              <button
                onClick={selectAllFiltered}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                Select All (Filtered)
              </button>
              {selectedTables.size > 0 && (
                <button
                  onClick={deselectAll}
                  className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                >
                  Deselect All
                </button>
              )}
            </div>

            <div className="mb-4 max-h-64 overflow-y-auto border border-gray-200 rounded p-2">
              {loading ? (
                <div className="text-center py-8 text-gray-500">Loading tables...</div>
              ) : filteredTables.length === 0 ? (
                <div className="text-center py-8 text-gray-500">No tables found</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {filteredTables.map((table) => (
                    <label
                      key={table.tableName}
                      className="flex items-center p-2 rounded hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedTables.has(table.table)}
                        onChange={() => toggleTable(table.table)}
                        className="mr-2"
                      />
                      <span className="text-sm text-gray-700 font-mono">{table.table}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={handleBackup}
              disabled={backingUp || selectedTables.size === 0}
              className="w-full px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
            >
              {backingUp 
                ? 'Creating Backup...' 
                : excludeMode
                  ? `Step 2: Backup All Tables (Excluding ${selectedTables.size})`
                  : `Step 2: Backup ${selectedTables.size} Table${selectedTables.size !== 1 ? 's' : ''}`}
            </button>
          </div>

          {/* Backup Tasks Section */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-gray-900">Backup Tasks</h2>
              <button
                onClick={loadBackupTasks}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                Refresh
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              View and manage backup tasks. Cancel running tasks or delete completed/failed tasks.
            </p>

            {loadingTasks ? (
              <div className="text-center py-8 text-gray-500">Loading tasks...</div>
            ) : backupTasks.length === 0 ? (
              <div className="text-center py-8 text-gray-500">No backup tasks found</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Details</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Filename</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Size</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {backupTasks.map((task) => {
                      const isSnapshot = !!(task.slot_name || task.snapshot_id);
                      const statusColors = {
                        pending: 'bg-yellow-100 text-yellow-800',
                        running: 'bg-blue-100 text-blue-800',
                        completed: 'bg-green-100 text-green-800',
                        failed: 'bg-red-100 text-red-800',
                        cancelled: 'bg-gray-100 text-gray-800',
                        stalled: 'bg-orange-100 text-orange-800',
                      };
                      
                      return (
                        <tr key={task.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-gray-900">
                                {task.schema_only ? 'Schema Only' : 'Full Backup'}
                              </span>
                              {isSnapshot && (
                                <span className="text-xs text-blue-600 font-medium">With Snapshot</span>
                              )}
                              {!isSnapshot && !task.schema_only && (
                                <span className="text-xs text-gray-500">Backup Only</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[task.status] || 'bg-gray-100 text-gray-800'}`}>
                              {task.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            <div className="space-y-1">
                              {task.tables && task.tables.length > 0 && (
                                <div className="text-xs">
                                  <span className="font-medium">Tables:</span> {task.tables.length}
                                </div>
                              )}
                              {task.exclude_tables && task.exclude_tables.length > 0 && (
                                <div className="text-xs">
                                  <span className="font-medium">Excluded:</span> {task.exclude_tables.length}
                                </div>
                              )}
                              {task.snapshot_id && (
                                <div className="text-xs text-blue-600">
                                  <span className="font-medium">Snapshot ID:</span> <span className="font-mono">{task.snapshot_id}</span>
                                </div>
                              )}
                              {task.slot_name && (
                                <div className="text-xs text-blue-600">
                                  <span className="font-medium">Replication Slot:</span> <span className="font-mono">{task.slot_name}</span>
                                </div>
                              )}
                              {task.publication_name && (
                                <div className="text-xs text-blue-600">
                                  <span className="font-medium">Publication:</span> <span className="font-mono">{task.publication_name}</span>
                                </div>
                              )}
                              {task.slot_initial_lsn && (
                                <div className="text-xs text-blue-600">
                                  <span className="font-medium">Initial LSN:</span> <span className="font-mono">{task.slot_initial_lsn}</span>
                                </div>
                              )}
                              {task.schema_only && (
                                <div className="text-xs text-gray-500">
                                  <span className="font-medium">Schema Only:</span> Yes
                                </div>
                              )}
                              {task.error_message && (
                                <div className="text-xs text-red-600 truncate max-w-xs" title={task.error_message}>
                                  <span className="font-medium">Error:</span> {task.error_message}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-900">
                            {task.filename || '-'}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-600">
                            {task.file_size ? formatBytes(task.file_size) : '-'}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                            {new Date(task.created_at).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-center">
                            <div className="flex gap-2 justify-center">
                              {(task.status === 'running' || task.status === 'pending') && (
                                <button
                                  onClick={() => handleCancelTask(task.id)}
                                  className="px-3 py-1.5 bg-yellow-600 text-white rounded text-sm hover:bg-yellow-700"
                                >
                                  Cancel
                                </button>
                              )}
                              {task.status === 'stalled' && (
                                <>
                                  <button
                                    onClick={() => handleCancelTask(task.id)}
                                    className="px-3 py-1.5 bg-yellow-600 text-white rounded text-sm hover:bg-yellow-700"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => handleDeleteTask(task.id, !!task.filepath)}
                                    className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700"
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                              {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
                                <button
                                  onClick={() => handleDeleteTask(task.id, !!task.filepath)}
                                  className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Restore Section */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Restore Backups</h2>
            <p className="text-sm text-gray-600 mb-4">
              Restore backups to target database (uses TARGET_DATABASE_URL from environment)
            </p>

            {loadingBackups ? (
              <div className="text-center py-8 text-gray-500">Loading backups...</div>
            ) : backups.length === 0 ? (
              <div className="text-center py-8 text-gray-500">No backups found</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Filename</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Size</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {backups.map((backup) => (
                      <tr key={backup.filename} className="hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-900">
                          {backup.filename}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-600">
                          {formatBytes(backup.size)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                          {new Date(backup.created).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-center">
                          <button
                            onClick={() => handleRestore(backup.filename)}
                            disabled={restoring[backup.filename]}
                            className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                          >
                            {restoring[backup.filename] ? 'Restoring...' : 'Restore'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
