import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { GoldskyAnalysisService } from '@/lib/services/goldsky-analysis.service';
import { ApplicationTrackingService } from '@/lib/services/application-tracking.service';
// RateOfChangeService removed - we track metrics directly in table_replication_metrics

interface DatabaseLocation {
  type: 'source' | 'target';
  provider: 'aws' | 'gcp' | 'unknown';
  host?: string;
  label: string; // Human-readable label like "Source (AWS RDS)" or "Target (GCP Cloud SQL)"
}

interface TableInfo {
  tableName: string;
  schema: string;
  table: string;
  sourceRowCount: number;
  targetRowCount: number;
  rowDiff: number;
  sourceSize: number;
  targetSize: number;
  subscriptions: string[];
  goldskyIndexed: boolean;
  goldskyPipeline?: string;
  services?: string[]; // Services that write to this table
  serviceDetails?: Array<{
    service: string;
    operation: string;
    count: number;
    lastWriteTime?: Date;
    username?: string;
    clientAddr?: string;
  }>;
  databaseLocation?: DatabaseLocation; // Which database this table is in
  isEstimate?: boolean;
  shouldReplicate?: boolean; // ✅ Safe to replicate (only source writers or none)
  writersOnSource?: string[]; // Services writing to AWS
  writersOnTarget?: string[]; // Services writing to GCP
  writersOnBoth?: boolean; // True if writers on both sides
  rateOfChange1Hour?: number | null; // Rows per minute over last 1 hour
  rateOfChange24Hour?: number | null; // Rows per minute over last 24 hours
  loading?: boolean; // Flag to indicate stats are still being loaded
}

/**
 * Detect database provider and location from connection string
 */
function detectDatabaseLocation(connectionString: string, type: 'source' | 'target'): DatabaseLocation {
  try {
    const url = new URL(connectionString);
    const host = url.hostname;
    
    // Detect provider from hostname
    let provider: 'aws' | 'gcp' | 'unknown' = 'unknown';
    if (host.includes('.rds.amazonaws.com') || host.includes('.rds.') || host.match(/^[a-z0-9-]+\.rds\./)) {
      provider = 'aws';
    } else if (host.includes('.sql') || host.includes('cloudsql') || host.includes('gcp')) {
      provider = 'gcp';
    }
    
    // Generate label
    let label = type === 'source' ? 'Source' : 'Target';
    if (provider === 'aws') {
      label += ' (AWS RDS)';
    } else if (provider === 'gcp') {
      label += ' (GCP Cloud SQL)';
    }
    
    return {
      type,
      provider,
      host,
      label,
    };
  } catch {
    return {
      type,
      provider: 'unknown',
      label: type === 'source' ? 'Source' : 'Target',
    };
  }
}

// Cache for table stats (1 minute TTL - fast with reltuples!)
const tableStatsCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 1 * 60 * 1000; // 1 minute

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only log detailed debug info if explicitly requested
  const debugMode = req.query.debug === 'true';
  if (debugMode) {
    console.log('[tables/all] ========== API Request Started ==========');
  }
  
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  // Check cache first
  const cacheKey = 'all-tables';
  const cached = tableStatsCache.get(cacheKey);
  const now = Date.now();
  
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    if (debugMode) {
      console.log('[tables/all] Returning cached data');
    }
    return res.status(200).json(cached.data);
  }

  // Force refresh parameter
  const forceRefresh = req.query.refresh === 'true';

  try {
    const pool = getDbPool();
    if (debugMode) {
      console.log('[tables/all] Connected to monitoring database');
    }
    
    // Get all subscriptions to map tables
    const subscriptionsResult = await pool.query(`
      SELECT id, name, publication_name, source_db_connection, target_db_connection
      FROM subscriptions
      ORDER BY name
    `);

    const subscriptions = subscriptionsResult.rows;
    // Only log subscription count, not every detail
    if (debugMode) {
      if (subscriptions.length === 0) {
        console.log(`[tables/all] No subscriptions found. Metrics tracking will be skipped.`);
      } else {
        console.log(`[tables/all] Found ${subscriptions.length} subscriptions`);
      }
    }


    // Get connection strings - try from subscriptions first, then from env/config
    let sourceConnection: string | null = null;
    let targetConnection: string | null = null;

    if (subscriptions.length > 0) {
      // Use first subscription's connections
      const firstSub = subscriptions[0];
      sourceConnection = firstSub.source_db_connection;
      targetConnection = firstSub.target_db_connection;
      console.log('[tables/all] Using connections from subscription:', firstSub.name);
    }
    
    // Always try environment variables as fallback (even if subscriptions exist but have empty connections)
    if (!sourceConnection || !targetConnection) {
      console.log('[tables/all] Trying to get connections from environment/K8s...');
      // Try to get from environment or Kubernetes secret
      try {
        const port = process.env.PORT || '3000';
        const connectionsRes = await fetch(`${req.headers.origin || `http://localhost:${port}`}/api/config/connections`);
        if (connectionsRes.ok) {
          const connections = await connectionsRes.json();
          sourceConnection = sourceConnection || connections.sourceDbConnection || process.env.SOURCE_DATABASE_URL || null;
          targetConnection = targetConnection || connections.targetDbConnection || process.env.TARGET_DATABASE_URL || null;
          console.log('[tables/all] Got connections from /api/config/connections');
        }
        } catch (err) {
        console.log('[tables/all] Failed to fetch /api/config/connections, using env vars');
        // Fallback to environment variables
        // Use TARGET_DATABASE_URL environment variable
        sourceConnection = sourceConnection || process.env.SOURCE_DATABASE_URL || null;
        targetConnection = targetConnection || process.env.TARGET_DATABASE_URL || null;
      }
    }
    
    // Also check environment variables directly (in case they weren't checked above)
    if (!sourceConnection) {
      sourceConnection = process.env.SOURCE_DATABASE_URL || null;
    }
    if (!targetConnection) {
      targetConnection = process.env.TARGET_DATABASE_URL || null;
    }
    
    // Debug: Check what's actually in process.env (only in debug mode)
    if (debugMode) {
      console.log('[tables/all] Environment variables check:');
      console.log(`  process.env.SOURCE_DATABASE_URL: ${process.env.SOURCE_DATABASE_URL ? 'SET (' + process.env.SOURCE_DATABASE_URL.substring(0, 30) + '...)' : 'NOT SET'}`);
      console.log(`  process.env.TARGET_DATABASE_URL: ${process.env.TARGET_DATABASE_URL ? 'SET (' + process.env.TARGET_DATABASE_URL.substring(0, 30) + '...)' : 'NOT SET'}`);
      
      // Log what we found (hide passwords)
      console.log('[tables/all] Connection status:');
      console.log(`  Source: ${sourceConnection ? sourceConnection.replace(/:[^:@]+@/, ':***@').substring(0, 60) + '...' : 'NOT SET'}`);
      console.log(`  Target: ${targetConnection ? targetConnection.replace(/:[^:@]+@/, ':***@').substring(0, 60) + '...' : 'NOT SET'}`);
    }

    // We need at least ONE database connection (prefer target/GCP as it's the destination)
    // This breaks the catch-22: we can show tables from GCP even without a subscription
    if (!sourceConnection && !targetConnection) {
      console.error('[tables/all] ❌ ERROR: No database connections available!');
      if (debugMode) {
        console.log('[tables/all] Please add to .env.local:');
        console.log('[tables/all]   TARGET_DATABASE_URL=postgresql://user:pass@host:5432/dbname');
      }
      return res.status(200).json({ 
        tables: [], 
        totalTables: 0,
        message: 'No database connections found. Please set SOURCE_DATABASE_URL and/or TARGET_DATABASE_URL environment variables.',
        hint: 'You can set these in .env.local or via K8s secret postgres-replication-secrets'
      });
    }
    
    if (debugMode) {
      console.log('[tables/all] ✓ At least one database connection available');
    }

    // Create pools only for available connections
    const sourcePool = sourceConnection ? createSourceTargetPool(sourceConnection) : null;
    const targetPool = targetConnection ? createSourceTargetPool(targetConnection) : null;
    const monitoringPool = getDbPool();
    
    // Get latest metrics for rate of change calculation (from table_replication_metrics)
    // This replaces the separate rate of change service - we track metrics directly
    const latestMetricsMap = new Map<string, { sourceRowCount: number; targetRowCount: number; timestamp: Date }>();
    try {
      if (subscriptions.length > 0) {
        const metricsIdColumnCheck = await monitoringPool.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'table_replication_metrics' 
            AND column_name IN ('subscription_id', 'group_id')
          LIMIT 1
        `).catch(() => ({ rows: [] }));
        
        const metricsIdColumn = metricsIdColumnCheck.rows[0]?.column_name || 'subscription_id';
        const subscriptionIdForMetrics = subscriptions[0].id;
        
        // Get latest metrics for each table (most recent per table)
        const latestMetricsResult = await monitoringPool.query(`
          SELECT DISTINCT ON (table_name)
            table_name,
            source_row_count,
            target_row_count,
            timestamp
          FROM table_replication_metrics
          WHERE ${metricsIdColumn} = $1
          ORDER BY table_name, timestamp DESC
        `, [subscriptionIdForMetrics]).catch(() => ({ rows: [] }));
        
        for (const row of latestMetricsResult.rows) {
          latestMetricsMap.set(row.table_name.toLowerCase(), {
            sourceRowCount: parseInt(row.source_row_count || '0', 10),
            targetRowCount: parseInt(row.target_row_count || '0', 10),
            timestamp: new Date(row.timestamp),
          });
        }
      }
    } catch (error: any) {
      // Ignore errors - metrics are optional
      if (debugMode) {
        console.log('[tables/all] Could not load latest metrics:', error.message);
      }
    }
    
    // Cache subscription statuses (fetch once for all tables instead of per-table queries)
    const subscriptionStatusCache = new Map<string, 'active' | 'stopped' | 'error'>();
    if (targetPool && subscriptions.length > 0) {
      try {
        const allSubNames = subscriptions.map((s: any) => s.name);
        const allSubStatusResult = await targetPool.query(`
          SELECT 
            s.subname,
            s.subenabled as enabled,
            ss.pid as worker_pid
          FROM pg_subscription s
          LEFT JOIN pg_stat_subscription ss ON s.subname = ss.subname
          WHERE s.subname = ANY($1)
        `, [allSubNames]);
        
        for (const row of allSubStatusResult.rows) {
          if (row.enabled && row.worker_pid !== null) {
            subscriptionStatusCache.set(row.subname, 'active');
          } else if (row.enabled && row.worker_pid === null) {
            subscriptionStatusCache.set(row.subname, 'error');
          } else {
            subscriptionStatusCache.set(row.subname, 'stopped');
          }
        }
      } catch (err) {
        // If we can't check status, mark all as active (default)
        for (const sub of subscriptions) {
          subscriptionStatusCache.set(sub.name, 'active');
        }
      }
    }
    
    // Detect database locations (handle null connections)
    const sourceLocation = sourceConnection ? detectDatabaseLocation(sourceConnection, 'source') : null;
    const targetLocation = targetConnection ? detectDatabaseLocation(targetConnection, 'target') : null;

    // Get backup info for tables
    let tableBackupInfo = new Map<string, { lastBackupDate?: string; lastBackupId?: string; tables?: string[] }>();
    try {
      const backupInfoResult = await monitoringPool.query(`
        WITH table_backups AS (
          SELECT 
            UNNEST(tables) as table_name,
            id as backup_id,
            completed_at as backup_date,
            tables as backup_tables,
            ROW_NUMBER() OVER (PARTITION BY UNNEST(tables) ORDER BY completed_at DESC NULLS LAST, created_at DESC) as rn
          FROM backup_tasks
          WHERE 
            task_type = 'backup'
            AND status = 'completed'
            AND tables IS NOT NULL
            AND array_length(tables, 1) > 0
            AND completed_at IS NOT NULL
        )
        SELECT 
          table_name,
          backup_id,
          backup_date,
          backup_tables
        FROM table_backups
        WHERE rn = 1
      `);
      
      backupInfoResult.rows.forEach((row: any) => {
        // Normalize table name: remove public. prefix, remove quotes, convert to lowercase
        const normalizedTable = row.table_name
          .replace(/^public\./, '')
          .replace(/^"/, '')
          .replace(/"$/, '')
          .toLowerCase();
        
        // Store with normalized key for consistent lookup
        tableBackupInfo.set(normalizedTable, {
          lastBackupDate: row.backup_date ? new Date(row.backup_date).toISOString() : undefined,
          lastBackupId: row.backup_id,
          tables: row.backup_tables,
        });
      });
    } catch (error) {
      console.warn('[tables/all] Failed to fetch backup info:', error);
    }

    // Get historical metrics for rate of change calculation
    // Query table_replication_metrics to get previous row counts per table
    // Fetch both 1-hour and 24-hour historical data
    let historical1Hour = new Map<string, { sourceRowCount: number; timestamp: Date }>();
    let historical24Hour = new Map<string, { sourceRowCount: number; timestamp: Date }>();
    
    try {
      // Check which column exists (subscription_id or group_id)
      const metricsColumnCheck = await monitoringPool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'table_replication_metrics' 
          AND column_name IN ('subscription_id', 'group_id')
        LIMIT 1
      `).catch(() => ({ rows: [] }));
      
      const metricsIdColumn = metricsColumnCheck.rows[0]?.column_name || 'subscription_id';
      
      // Get metrics from ~1 hour ago (50-70 minutes ago to allow for data collection delays)
      const historical1HourResult = await monitoringPool.query(`
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(table_name, '^[^.]+\.', '')))
          table_name,
          REGEXP_REPLACE(table_name, '^[^.]+\.', '') as normalized_table_name,
          source_row_count,
          timestamp
        FROM table_replication_metrics
        WHERE timestamp >= NOW() - INTERVAL '70 minutes'
          AND timestamp <= NOW() - INTERVAL '50 minutes'
          AND source_row_count IS NOT NULL
          AND source_row_count > 0
        ORDER BY LOWER(REGEXP_REPLACE(table_name, '^[^.]+\.', '')), timestamp DESC
      `).catch((err) => {
        console.warn('[tables/all] 1-hour metrics query failed:', err);
        return { rows: [] };
      });
      
      for (const row of historical1HourResult.rows) {
        const normalizedTable = (row.normalized_table_name || row.table_name).toLowerCase();
        historical1Hour.set(normalizedTable, {
          sourceRowCount: parseInt(row.source_row_count || '0', 10),
          timestamp: new Date(row.timestamp),
        });
      }
      
      // Get metrics from ~24 hours ago (23-25 hours ago)
      const historical24HourResult = await monitoringPool.query(`
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(table_name, '^[^.]+\.', '')))
          table_name,
          REGEXP_REPLACE(table_name, '^[^.]+\.', '') as normalized_table_name,
          source_row_count,
          timestamp
        FROM table_replication_metrics
        WHERE timestamp >= NOW() - INTERVAL '25 hours'
          AND timestamp <= NOW() - INTERVAL '23 hours'
          AND source_row_count IS NOT NULL
          AND source_row_count > 0
        ORDER BY LOWER(REGEXP_REPLACE(table_name, '^[^.]+\.', '')), timestamp DESC
      `).catch((err) => {
        console.warn('[tables/all] 24-hour metrics query failed:', err);
        return { rows: [] };
      });
      
      for (const row of historical24HourResult.rows) {
        const normalizedTable = (row.normalized_table_name || row.table_name).toLowerCase();
        historical24Hour.set(normalizedTable, {
          sourceRowCount: parseInt(row.source_row_count || '0', 10),
          timestamp: new Date(row.timestamp),
        });
      }
    } catch (err) {
      // Ignore errors - rate of change is optional
      console.warn('[tables/all] Could not fetch historical metrics:', err);
    }

    // Get Goldsky table mappings
    const goldskyService = new GoldskyAnalysisService();
    const goldskyTables = await goldskyService.getGoldskyTables().catch(() => new Set<string>());
    const goldskyPipelines = await goldskyService.parsePipelines().catch(() => []);
    
    // Create a map of table -> pipeline
    const tableToPipeline = new Map<string, string>();
    for (const pipeline of goldskyPipelines) {
      for (const table of pipeline.tables || []) {
        tableToPipeline.set(table, pipeline.name);
      }
    }

    // Get service write stats (which services write to which tables)
    // Query BOTH source (AWS) and target (GCP) databases separately
    const appTrackingService = new ApplicationTrackingService();
    
    // Get writers from source database (AWS)
    const sourceWriteStats = sourcePool 
      ? await appTrackingService.getWriteStatsByApplication(sourcePool).catch((err) => {
          console.log('[application-tracking] Failed to get source write stats:', err.message);
          return [];
        })
      : [];
    
    // Get writers from target database (GCP)
    const targetWriteStats = targetPool
      ? await appTrackingService.getWriteStatsByApplication(targetPool).catch((err) => {
          console.log('[application-tracking] Failed to get target write stats:', err.message);
          return [];
        })
      : [];
    
    console.log(`[application-tracking] Found ${sourceWriteStats.length} write stats from source (AWS)`);
    console.log(`[application-tracking] Found ${targetWriteStats.length} write stats from target (GCP)`);
    
    // Create a map of table -> services with operation details
    const tableToServices = new Map<string, Set<string>>();
    const tableToServiceDetails = new Map<string, Array<{
      service: string;
      operation: string;
      count: number;
      lastWriteTime?: Date;
      username?: string;
      clientAddr?: string;
      dbLocation?: string;
    }>>();
    
    // Track which services write to which database for each table
    const tableToSourceWriters = new Map<string, Set<string>>(); // Services writing to source (AWS)
    const tableToTargetWriters = new Map<string, Set<string>>(); // Services writing to target (GCP)
    
    // Process source (AWS) writers
    for (const stat of sourceWriteStats) {
      const tableKey = stat.table.toLowerCase();
      
      if (!tableToSourceWriters.has(tableKey)) {
        tableToSourceWriters.set(tableKey, new Set());
      }
      tableToSourceWriters.get(tableKey)!.add(stat.applicationName);
      
      // Add to all services set
      if (!tableToServices.has(tableKey)) {
        tableToServices.set(tableKey, new Set());
      }
      tableToServices.get(tableKey)!.add(stat.applicationName);
      
      // Add to detailed services map
      if (!tableToServiceDetails.has(tableKey)) {
        tableToServiceDetails.set(tableKey, []);
      }
      tableToServiceDetails.get(tableKey)!.push({
        service: stat.applicationName,
        operation: stat.operation,
        count: stat.count,
        lastWriteTime: stat.lastWriteTime,
        username: (stat as any).username,
        clientAddr: (stat as any).clientAddr,
        dbLocation: 'source',
      });
    }
    
    // Process target (GCP) writers
    for (const stat of targetWriteStats) {
      const tableKey = stat.table.toLowerCase();
      
      if (!tableToTargetWriters.has(tableKey)) {
        tableToTargetWriters.set(tableKey, new Set());
      }
      tableToTargetWriters.get(tableKey)!.add(stat.applicationName);
      
      // Add to all services set
      if (!tableToServices.has(tableKey)) {
        tableToServices.set(tableKey, new Set());
      }
      tableToServices.get(tableKey)!.add(stat.applicationName);
      
      // Add to detailed services map
      if (!tableToServiceDetails.has(tableKey)) {
        tableToServiceDetails.set(tableKey, []);
      }
      tableToServiceDetails.get(tableKey)!.push({
        service: stat.applicationName,
        operation: stat.operation,
        count: stat.count,
        lastWriteTime: stat.lastWriteTime,
        username: (stat as any).username,
        clientAddr: (stat as any).clientAddr,
        dbLocation: 'target',
      });
    }
    
    // Log some example tables with writers
    if (tableToTargetWriters.size > 0) {
      console.log('[application-tracking] GCP writers by table (sample):');
      let count = 0;
      for (const [table, writers] of tableToTargetWriters.entries()) {
        if (count++ < 5) {
          console.log(`  - ${table}: ${Array.from(writers).join(', ')}`);
        }
      }
    }

        try {
          // Get all tables from available databases (source and/or target)
          // Priority: Show tables from GCP (target) first, then augment with source if available
          const sourceTablesPromise = sourcePool ? sourcePool.query(`
            SELECT 
              schemaname || '.' || tablename as table_name,
              schemaname,
              tablename
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename
          `).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] });

          const targetTablesPromise = targetPool ? targetPool.query(`
            SELECT 
              schemaname || '.' || tablename as table_name,
              schemaname,
              tablename
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename
          `).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] });

          const [sourceTablesResult, targetTablesResult] = await Promise.all([
            sourceTablesPromise,
            targetTablesPromise
          ]);

      if (debugMode) {
        console.log(`[tables/all] Found ${sourceTablesResult.rows.length} tables in source`);
        console.log(`[tables/all] Found ${targetTablesResult.rows.length} tables in target`);
      }

      // Merge tables from both databases, using a Set to avoid duplicates
      const allTablesMap = new Map<string, { table_name: string; schemaname: string; tablename: string }>();
      
      // Add source tables
      for (const row of sourceTablesResult.rows) {
        allTablesMap.set(row.table_name, row);
      }
      
      // Add target tables (will overwrite if same name, but that's fine)
      for (const row of targetTablesResult.rows) {
        allTablesMap.set(row.table_name, row);
      }
      
      if (debugMode) {
        console.log(`[tables/all] Total unique tables: ${allTablesMap.size}`);
      }
      
      // Convert to array sorted by table name
      const allTables = Array.from(allTablesMap.values()).sort((a, b) => 
        a.tablename.localeCompare(b.tablename)
      );

      // Get table -> subscription mapping
      const tableSubscriptions = new Map<string, string[]>();
      
      // Only query publication tables if we have subscriptions configured
      if (subscriptions.length > 0) {
        for (const sub of subscriptions) {
          // Skip if connection is not set
          if (!sub.source_db_connection) continue;
          
          const subSourcePool = createSourceTargetPool(sub.source_db_connection);
          try {
            const pubTablesResult = await subSourcePool.query(`
              SELECT schemaname || '.' || tablename as table_name
              FROM pg_publication_tables
              WHERE pubname = $1
            `, [sub.publication_name]);

            for (const row of pubTablesResult.rows) {
              const tableName = row.table_name;
              if (!tableSubscriptions.has(tableName)) {
                tableSubscriptions.set(tableName, []);
              }
              tableSubscriptions.get(tableName)!.push(sub.name);
            }
          } catch (err) {
            console.warn(`[tables/all] Failed to get publication tables for subscription ${sub.name}:`, err);
          } finally {
            await subSourcePool.end();
          }
        }
      }

      // Query ALL tables - we'll cache the results to avoid querying on every page load
      const tablesToProcess = allTables;
      

      // First, create a quick list of all tables with basic info (no stats yet)
      // This allows the UI to show tables immediately while we fetch detailed stats
      const quickTableList: TableInfo[] = allTables.map((row: any) => {
        const [schema, table] = row.table_name.split('.');
        const tableKey = table.toLowerCase();
        return {
          tableName: row.table_name,
          schema,
          table,
          sourceRowCount: 0,
          targetRowCount: 0,
          rowDiff: 0,
          sourceSize: 0,
          targetSize: 0,
          subscriptions: tableSubscriptions.get(row.table_name) || [],
          goldskyIndexed: goldskyTables.has(table) || goldskyTables.has(row.table_name),
          goldskyPipeline: tableToPipeline.get(table) || tableToPipeline.get(row.table_name),
          services: Array.from(tableToServices.get(tableKey) || new Set<string>()) as string[],
          serviceDetails: tableToServiceDetails.get(tableKey) || [],
          databaseLocation: sourceLocation || undefined,
          isEstimate: false,
          loading: true, // Flag to indicate stats are being loaded
        };
      });

      // If this is not a force refresh and we have cached data, return quick list immediately
      // Then process stats in background (but we can't do true background in Next.js, so we'll process synchronously)
      // For now, we'll process all stats but return the quick list structure so UI can show it

      // OPTIMIZATION: Fetch all table estimates in bulk using reltuples (super fast!)
      // This is much faster than querying each table individually
      const sourceStatsMap = new Map<string, { estimate: number; size: number }>();
      const targetStatsMap = new Map<string, { estimate: number; size: number }>();
      
      // Get all source table stats in one query
      if (sourcePool) {
        try {
          const sourceStatsResult = await sourcePool.query(`
            SELECT 
              n.nspname || '.' || c.relname as table_name,
              c.reltuples::bigint as estimated_rows,
              pg_total_relation_size(c.oid) as size
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r'
              AND n.nspname = 'public'
            ORDER BY c.reltuples DESC
          `);
          
          for (const row of sourceStatsResult.rows) {
            sourceStatsMap.set(row.table_name, {
              estimate: parseInt(row.estimated_rows || '0', 10),
              size: parseInt(row.size || '0', 10),
            });
          }
        } catch (err: any) {
          console.warn('[tables/all] Failed to fetch bulk source stats:', err.message);
        }
      }
      
      // Get all target table stats in one query
      if (targetPool) {
        try {
          const targetStatsResult = await targetPool.query(`
            SELECT 
              n.nspname || '.' || c.relname as table_name,
              c.reltuples::bigint as estimated_rows,
              pg_total_relation_size(c.oid) as size
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r'
              AND n.nspname = 'public'
            ORDER BY c.reltuples DESC
          `);
          
          for (const row of targetStatsResult.rows) {
            targetStatsMap.set(row.table_name, {
              estimate: parseInt(row.estimated_rows || '0', 10),
              size: parseInt(row.size || '0', 10),
            });
          }
        } catch (err: any) {
          console.warn('[tables/all] Failed to fetch bulk target stats:', err.message);
        }
      }

      // Get stats for all tables - process all at once since reltuples is super fast!
      // Only batch the COUNT(*) queries for subscribed tables (those are slower)
      const tableStats: TableInfo[] = [];
      
      // Process all tables in parallel (reltuples is fast, no need to batch)
      const allTableResults = await Promise.all(
        tablesToProcess.map(async (row: any) => {
          const tableName = row.table_name;
          const [schema, table] = tableName.split('.');

          try {
            // Get source row count and size from bulk stats map (super fast!)
            let sourceCount = 0;
            let sourceSize = 0;
            const sourceStats = sourceStatsMap.get(tableName);
            
            if (sourceStats) {
              sourceCount = Math.max(0, sourceStats.estimate);
              sourceSize = sourceStats.size;
            }
            
            // Get target row count and size from bulk stats map (super fast!)
            let targetCount = 0;
            let targetSize = 0;
            const targetStats = targetStatsMap.get(tableName);
            
            if (targetStats) {
              targetCount = Math.max(0, targetStats.estimate);
              targetSize = targetStats.size;
            }
            
            // For tables in subscriptions, get exact counts for accurate diff calculation
            const tableSubsForCount = tableSubscriptions.get(tableName) || [];
            const isInSubscription = tableSubsForCount.length > 0;
            
            // Track whether we're using exact counts or estimates
            let usingExactCount = false;
            
            // OPTIMIZATION: Use estimates for ALL tables - COUNT(*) is too expensive
            // Only use exact counts for small tables (< 500K rows) in subscriptions
            // For larger tables, estimates are used - be careful about data integrity claims
            if (isInSubscription && sourceStats && sourceStats.estimate < 500000 && sourceStats.estimate > 0) {
              // Only get exact count for small tables where estimate might be inaccurate
              usingExactCount = true;
              if (sourcePool && sourceStats) {
                try {
                  const sourceCountResult = await sourcePool.query(`
                    SELECT COUNT(*) as count
                    FROM ${tableName}::regclass
                  `).catch(() => {
                    return sourcePool.query(`
                      SELECT COUNT(*) as count
                      FROM ${schema}."${table}"
                    `).catch(() => {
                      return sourcePool.query(`
                        SELECT COUNT(*) as count
                        FROM ${schema}.${table}
                      `);
                    });
                  });
                  sourceCount = parseInt(sourceCountResult.rows[0]?.count || '0', 10);
                } catch {
                  // Fallback to estimate if COUNT fails
                  sourceCount = Math.max(0, sourceStats.estimate);
                  usingExactCount = false;
                }
              }
              
              if (targetPool && targetStats) {
                try {
                  const targetCountResult = await targetPool.query(`
                    SELECT COUNT(*) as count
                    FROM ${tableName}::regclass
                  `).catch(() => {
                    return targetPool.query(`
                      SELECT COUNT(*) as count
                      FROM ${schema}."${table}"
                    `).catch(() => {
                      return targetPool.query(`
                        SELECT COUNT(*) as count
                        FROM ${schema}.${table}
                      `);
                    });
                  });
                  targetCount = parseInt(targetCountResult.rows[0]?.count || '0', 10);
                } catch {
                  // Fallback to estimate if COUNT fails
                  targetCount = Math.max(0, targetStats.estimate);
                  usingExactCount = false;
                }
              }
            } else if (isInSubscription) {
              // For larger tables (>= 500K), use estimates (fast but less accurate)
              // BE CAREFUL: Estimates can be off by 10-20%, so be conservative with data integrity claims
              sourceCount = sourceStats?.estimate || 0;
              targetCount = targetStats?.estimate || 0;
              usingExactCount = false;
            }

            const tableSubs = tableSubscriptions.get(tableName) || []; // This table's subscriptions (which subscriptions include this table)
            
            // Check actual replication status for subscriptions that include this table
            // Use cached subscription status map (fetched once for all tables)
            let replicationStatus: 'active' | 'stopped' | 'error' | 'none' = 'none';
            if (tableSubs.length > 0) {
              // Find first matching subscription status from cache
              for (const subName of tableSubs) {
                const cachedStatus = subscriptionStatusCache.get(subName);
                if (cachedStatus) {
                  replicationStatus = cachedStatus;
                  break;
                }
              }
            }
            
            const goldskyIndexed = goldskyTables.has(table) || goldskyTables.has(tableName);
            const goldskyPipeline = tableToPipeline.get(table) || tableToPipeline.get(tableName);
            
            // Get services that write to this table
            const tableKey = table.toLowerCase();
            const servicesSet = tableToServices.get(tableKey) || new Set();
            const services = Array.from(servicesSet);
            const serviceDetails = tableToServiceDetails.get(tableKey) || [];

            // Determine which database this table primarily exists in
            // If table exists in both, prefer source (where writes happen)
            // If only in one, use that location
            // If pools are null, use the available one
            const existsInSource = sourceCount > 0 || sourceSize > 0;
            const existsInTarget = targetCount > 0 || targetSize > 0;
            const databaseLocation = existsInSource && sourceLocation ? sourceLocation 
                                  : (existsInTarget && targetLocation ? targetLocation 
                                  : (sourceLocation || targetLocation || { type: 'target' as const, provider: 'unknown' as const, label: 'Unknown' }));

            // CRITICAL: Detect if services write to BOTH source and target
            // This is the key decision point: if writers on both sides, DON'T replicate
            const sourceWriters: string[] = Array.from(tableToSourceWriters.get(tableKey) || new Set<string>());
            const targetWriters: string[] = Array.from(tableToTargetWriters.get(tableKey) || new Set<string>());
            const hasWritersOnBothSides = sourceWriters.length > 0 && targetWriters.length > 0;
            const hasWritersOnSourceOnly = sourceWriters.length > 0 && targetWriters.length === 0;
            const hasNoWriters = sourceWriters.length === 0 && targetWriters.length === 0;
            
            // Should replicate if: only source writers OR no writers at all
            const shouldReplicate = hasWritersOnSourceOnly || hasNoWriters;
            
                // Replication risk: writers on both sides = conflict risk
                const hasReplicationRisk = hasWritersOnBothSides;
                const hasActiveWriters = sourceWriters.length > 0 || targetWriters.length > 0;
                const isBeingReplicated = subscriptions.some(sub => 
                  (tableSubscriptions.get(tableName) || []).includes(sub.name)
                );

                // Calculate rate of change from stored metrics
                let rateOfChange1Hour: number | null = null;
                let rateOfChange24Hour: number | null = null;
                
                // Get historical data from table_replication_metrics
                const normalizedTable = table.toLowerCase();
                const data1Hour = historical1Hour.get(normalizedTable);
                const data24Hour = historical24Hour.get(normalizedTable);
                
                // Calculate 1-hour rate
                if (data1Hour && data1Hour.sourceRowCount > 0 && sourceCount > 0) {
                  const now = new Date();
                  const timeDiffMs = now.getTime() - data1Hour.timestamp.getTime();
                  const timeDiffMinutes = timeDiffMs / (1000 * 60);
                  
                  if (timeDiffMinutes > 0 && timeDiffMinutes <= 120) { // Only if within reasonable range (0-2 hours)
                    const rowChange = sourceCount - data1Hour.sourceRowCount;
                    rateOfChange1Hour = rowChange / timeDiffMinutes;
                  }
                }
                
                // Calculate 24-hour rate
                if (data24Hour && data24Hour.sourceRowCount > 0 && sourceCount > 0) {
                  const now = new Date();
                  const timeDiffMs = now.getTime() - data24Hour.timestamp.getTime();
                  const timeDiffMinutes = timeDiffMs / (1000 * 60);
                  
                  if (timeDiffMinutes > 0 && timeDiffMinutes <= 1500) { // Only if within reasonable range (0-25 hours)
                    const rowChange = sourceCount - data24Hour.sourceRowCount;
                    rateOfChange24Hour = rowChange / timeDiffMinutes;
                  }
                }

                // Store current metrics for rate of change tracking
                // Smart storage: only store if row count changed OR if it's been >1 minute since last storage
                // This prevents storing duplicate data while ensuring we have regular snapshots
                if (subscriptions.length > 0) {
                  try {
                    const metricsIdColumnCheck = await monitoringPool.query(`
                      SELECT column_name 
                      FROM information_schema.columns 
                      WHERE table_name = 'table_replication_metrics' 
                        AND column_name IN ('subscription_id', 'group_id')
                      LIMIT 1
                    `).catch(() => ({ rows: [] }));
                    
                    const metricsIdColumn = metricsIdColumnCheck.rows[0]?.column_name || 'subscription_id';
                    const subscriptionIdForMetrics = subscriptions[0].id;
                    const tableNameForStorage = table; // Store just the table name, not schema.table
                    const now = new Date();
                    const truncatedTimestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
                    
                    // Check if we should store (only if changed or new minute)
                    const lastMetric = latestMetricsMap.get(normalizedTable);
                    const shouldStore = !lastMetric || 
                      lastMetric.sourceRowCount !== sourceCount || 
                      lastMetric.targetRowCount !== targetCount ||
                      (now.getTime() - lastMetric.timestamp.getTime()) >= 60000; // At least 1 minute passed
                    
                    // Store metrics asynchronously (don't wait) to avoid blocking
                    if (shouldStore) {
                      // Fire and forget - don't await to avoid blocking
                      monitoringPool.query(`
                        INSERT INTO table_replication_metrics (
                          ${metricsIdColumn}, table_name, timestamp, source_row_count, target_row_count, gap_size, status
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (${metricsIdColumn}, table_name, timestamp) DO UPDATE SET
                          source_row_count = EXCLUDED.source_row_count,
                          target_row_count = EXCLUDED.target_row_count,
                          gap_size = EXCLUDED.gap_size,
                          status = EXCLUDED.status
                      `, [
                        subscriptionIdForMetrics,
                        tableNameForStorage,
                        truncatedTimestamp,
                        sourceCount,
                        targetCount,
                        sourceCount - targetCount,
                        sourceCount === targetCount ? 'synced' : sourceCount > targetCount ? 'lagging' : 'error',
                      ]).catch((err) => {
                        // Log but ignore - metrics tracking is optional
                        if (debugMode) {
                          console.warn(`[tables/all] Failed to store metrics for ${table}:`, err.message);
                        }
                      });
                    }
                  } catch (err) {
                    // Ignore - metrics tracking is optional
                    if (debugMode) {
                      console.warn(`[tables/all] Error storing metrics for ${table}:`, err);
                    }
                  }
                }
                // Note: If no subscriptions exist, metrics tracking is skipped (this is fine - it's optional)

                // Get backup info for this table
                // Normalize table name the same way as when storing (remove public. prefix and quotes)
                const normalizedTableForBackup = tableName
                  .replace(/^public\./, '')
                  .replace(/^"/, '')
                  .replace(/"$/, '')
                  .toLowerCase();
                const backupInfo = tableBackupInfo.get(normalizedTableForBackup);
                
                return {
                  tableName,
                  schema,
                  table,
                  sourceRowCount: sourceCount,
                  targetRowCount: targetCount,
                  rowDiff: sourceCount - targetCount,
                  sourceSize,
                  targetSize,
                  subscriptions: tableSubs,
                  replicationStatus,
                  goldskyIndexed,
                  goldskyPipeline,
                  services,
                  serviceDetails, // Detailed service write information
                  databaseLocation, // Which database this table is in
                  hasReplicationRisk, // ⚠️ CRITICAL: Writers on both sides = PK conflict risk
                  lastBackupDate: backupInfo?.lastBackupDate,
                  lastBackupId: backupInfo?.lastBackupId,
                  lastBackupTables: backupInfo?.tables,
                  hasActiveWriters,
                  shouldReplicate, // ✅ Safe to replicate (only source writers or none)
                  writersOnSource: sourceWriters, // Services writing to AWS
                  writersOnTarget: targetWriters, // Services writing to GCP
                  writersOnBoth: hasWritersOnBothSides, // True if writers on both sides
                  isEstimate: !usingExactCount, // True if using estimates, false if using exact COUNT(*)
                  rateOfChange1Hour, // Rows per minute over last hour
                  rateOfChange24Hour, // Rows per minute over last 24 hours
                };
          } catch (error: any) {
            return {
              tableName,
              schema,
              table,
              sourceRowCount: 0,
              targetRowCount: 0,
              rowDiff: 0,
              sourceSize: 0,
              targetSize: 0,
              subscriptions: tableSubscriptions.get(tableName) || [],
              replicationStatus: 'none', // Will be set when processing stats
              goldskyIndexed: goldskyTables.has(table) || goldskyTables.has(tableName),
              goldskyPipeline: tableToPipeline.get(table) || tableToPipeline.get(tableName),
              services: Array.from(tableToServices.get(table.toLowerCase()) || new Set<string>()) as string[],
              serviceDetails: tableToServiceDetails.get(table.toLowerCase()) || [],
              databaseLocation: sourceLocation || undefined, // Default to source if we can't determine
              error: error.message,
            };
          }
          })
      );
      
      // Filter out errors and add to results
      tableStats.push(...allTableResults.filter((result: any) => result && !result.error));
      

      // Merge quick list with detailed stats
      // Create a map of tableName -> detailed stats
      const statsMap = new Map<string, TableInfo>();
      for (const stat of tableStats) {
        statsMap.set(stat.tableName, stat);
      }
      
      // Update quick list with actual stats where available
      const finalTables = quickTableList.map(quickTable => {
        const detailedStats = statsMap.get(quickTable.tableName);
        if (detailedStats) {
          return { ...detailedStats, loading: false }; // Use detailed stats, mark as loaded
        }
        return quickTable; // Keep quick table with loading flag
      });

      const response = {
        tables: finalTables,
        totalTables: allTables.length,
        checkedTables: tableStats.length,
        skippedTables: 0,
        subscriptions: subscriptions.map((s: any) => ({ id: s.id, name: s.name })),
        cached: false,
        cacheAge: 0,
        timestamp: new Date().toISOString(),
        loadingComplete: tableStats.length === allTables.length, // Indicate if all stats are loaded
      };

      // Cache the response
      tableStatsCache.set(cacheKey, {
        data: response,
        timestamp: now,
      });
      

      if (debugMode) {
        console.log(`[tables/all] ✓ Returning ${response.tables.length} tables`);
        console.log('[tables/all] ========== API Request Complete ==========');
      }
      
      res.status(200).json(response);
    } finally {
      // Only close pools that were actually created
      if (sourcePool) await sourcePool.end().catch(() => {});
      if (targetPool) await targetPool.end().catch(() => {});
    }
  } catch (error: any) {
    console.error('[tables/all] ❌ ERROR:', error.message);
    if (debugMode) {
      console.error('[tables/all] Stack trace:', error.stack);
      console.log('[tables/all] ========== API Request Failed ==========');
    }
    res.status(500).json({ error: error.message || 'Failed to get tables' });
  }
}

