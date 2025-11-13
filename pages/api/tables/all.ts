import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { GoldskyAnalysisService } from '@/lib/services/goldsky-analysis.service';
import { ApplicationTrackingService } from '@/lib/services/application-tracking.service';
import { RateOfChangeService } from '@/lib/services/rate-of-change.service';

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

// Cache for table stats (10 minute TTL)
const tableStatsCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log('[tables/all] ========== API Request Started ==========');
  
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  // Check cache first
  const cacheKey = 'all-tables';
  const cached = tableStatsCache.get(cacheKey);
  const now = Date.now();
  
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    console.log('[tables/all] Returning cached data');
    return res.status(200).json(cached.data);
  }

  // Force refresh parameter
  const forceRefresh = req.query.refresh === 'true';

  try {
    const pool = getDbPool();
    console.log('[tables/all] Connected to monitoring database');
    
    // Get all subscriptions to map tables
    const subscriptionsResult = await pool.query(`
      SELECT id, name, publication_name, source_db_connection, target_db_connection
      FROM subscriptions
      ORDER BY name
    `);

    const subscriptions = subscriptionsResult.rows;
    console.log(`[tables/all] Found ${subscriptions.length} subscriptions in monitoring DB`);

    // Initialize rate of change service and fetch all latest rates
    // Gracefully handle if table doesn't exist yet
    let rateOfChangeMap = new Map();
    try {
      const rateOfChangeService = new RateOfChangeService();
      rateOfChangeMap = await rateOfChangeService.getAllLatestRates();
      console.log(`[tables/all] Loaded ${rateOfChangeMap.size} rate of change entries`);
    } catch (error: any) {
      if (error.code === '42P01') {
        console.log('[tables/all] Rate of change table not yet created (run migration 002)');
      } else {
        console.log('[tables/all] Could not load rate of change data:', error.message);
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
    
    // Debug: Check what's actually in process.env
    console.log('[tables/all] Environment variables check:');
    console.log(`  process.env.SOURCE_DATABASE_URL: ${process.env.SOURCE_DATABASE_URL ? 'SET (' + process.env.SOURCE_DATABASE_URL.substring(0, 30) + '...)' : 'NOT SET'}`);
    console.log(`  process.env.TARGET_DATABASE_URL: ${process.env.TARGET_DATABASE_URL ? 'SET (' + process.env.TARGET_DATABASE_URL.substring(0, 30) + '...)' : 'NOT SET'}`);
    
    // Log what we found (hide passwords)
    console.log('[tables/all] Connection status:');
    console.log(`  Source: ${sourceConnection ? sourceConnection.replace(/:[^:@]+@/, ':***@').substring(0, 60) + '...' : 'NOT SET'}`);
    console.log(`  Target: ${targetConnection ? targetConnection.replace(/:[^:@]+@/, ':***@').substring(0, 60) + '...' : 'NOT SET'}`);

    // We need at least ONE database connection (prefer target/GCP as it's the destination)
    // This breaks the catch-22: we can show tables from GCP even without a subscription
    if (!sourceConnection && !targetConnection) {
      console.log('[tables/all] ❌ ERROR: No database connections available!');
      console.log('[tables/all] Please add to .env.local:');
      console.log('[tables/all]   TARGET_DATABASE_URL=postgresql://user:pass@host:5432/dbname');
      return res.status(200).json({ 
        tables: [], 
        totalTables: 0,
        message: 'No database connections found. Please set SOURCE_DATABASE_URL and/or TARGET_DATABASE_URL environment variables.',
        hint: 'You can set these in .env.local or via K8s secret postgres-replication-secrets'
      });
    }
    
    console.log('[tables/all] ✓ At least one database connection available');

    // Create pools only for available connections
    const sourcePool = sourceConnection ? createSourceTargetPool(sourceConnection) : null;
    const targetPool = targetConnection ? createSourceTargetPool(targetConnection) : null;
    const monitoringPool = getDbPool();
    
    // Detect database locations (handle null connections)
    const sourceLocation = sourceConnection ? detectDatabaseLocation(sourceConnection, 'source') : null;
    const targetLocation = targetConnection ? detectDatabaseLocation(targetConnection, 'target') : null;

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

      console.log(`[tables/all] Found ${sourceTablesResult.rows.length} tables in source`);
      console.log(`[tables/all] Found ${targetTablesResult.rows.length} tables in target`);

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
      
      console.log(`[tables/all] Total unique tables: ${allTablesMap.size}`);
      
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

      // Get stats for all tables - process in batches to avoid connection pool exhaustion
      // Process 10 tables at a time to prevent timeouts
      const BATCH_SIZE = 10;
      const tableStats: TableInfo[] = [];
      
      for (let i = 0; i < tablesToProcess.length; i += BATCH_SIZE) {
        const batch = tablesToProcess.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
          batch.map(async (row: any) => {
          const tableName = row.table_name;
          const [schema, table] = tableName.split('.');

          try {
            // Get source row count - use estimate for large tables
            // First check if table exists on source (skip if no source connection)
            let sourceCount = 0;
            let sourceSize = 0;
            let useEstimate = false;
            
            if (sourcePool) {
              try {
                // Optimized: Get both estimate and size in a single query using pg_class
                // This is much faster than separate queries
                const sourceStatsResult = await sourcePool.query(`
                  SELECT 
                    c.reltuples::bigint as estimate,
                    pg_total_relation_size(c.oid) as size
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE c.relname = $1 
                    AND n.nspname = $2
                    AND c.relkind = 'r'
                `, [table, schema]);
              
              if (sourceStatsResult.rows.length > 0) {
                const estimate = parseInt(sourceStatsResult.rows[0]?.estimate || '0', 10);
                sourceSize = parseInt(sourceStatsResult.rows[0]?.size || '0', 10);
                
                // Use estimate for all tables - COUNT(*) is too slow for large tables
                // Only use exact count for very small tables (< 10k) if we need precision
                useEstimate = estimate > 10000; // Use estimate for tables > 10k rows (much faster)
                
                if (useEstimate) {
                  sourceCount = Math.max(0, estimate);
                } else {
                  // For very small tables, use exact count (but this is still slow, so prefer estimate)
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
                    sourceCount = Math.max(0, estimate);
                    useEstimate = true;
                  }
                }
              }
              } catch (err: any) {
                // Table doesn't exist on source or query failed - this is normal for tables that only exist on one side
                // Only log if it's not a "does not exist" or timeout error
                if (!err.message?.includes('does not exist') && 
                    !err.message?.includes('relation') && 
                    !err.message?.includes('timeout')) {
                  console.warn(`[tables/all] Source query failed for ${tableName}:`, err.message);
                }
              }
            } else {
              // No source pool - skip source stats (this is fine, we can show tables from target only)
            }

            // Get target row count and size - optimized single query (skip if no target connection)
            let targetCount = 0;
            let targetSize = 0;
            
            if (targetPool) {
              try {
                // Optimized: Get both estimate and size in a single query
                const targetStatsResult = await targetPool.query(`
                  SELECT 
                    c.reltuples::bigint as estimate,
                    pg_total_relation_size(c.oid) as size
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE c.relname = $1 
                    AND n.nspname = $2
                    AND c.relkind = 'r'
                `, [table, schema]);
              
              if (targetStatsResult.rows.length > 0) {
                const estimate = parseInt(targetStatsResult.rows[0]?.estimate || '0', 10);
                targetSize = parseInt(targetStatsResult.rows[0]?.size || '0', 10);
                
                // Use estimate for all tables - COUNT(*) is too slow
                // Only use exact count for very small tables if needed
                const useExactCount = estimate > 0 && estimate <= 10000;
                
                if (useExactCount) {
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
                    targetCount = Math.max(0, estimate);
                  }
                } else {
                  targetCount = Math.max(0, estimate);
                }
              }
              } catch (err: any) {
                // Table doesn't exist on target or query failed - this is normal for tables that only exist on one side
                // Only log if it's not a "does not exist" or timeout error
                if (!err.message?.includes('does not exist') && 
                    !err.message?.includes('relation') && 
                    !err.message?.includes('timeout')) {
                  console.warn(`[tables/all] Target query failed for ${tableName}:`, err.message);
                }
              }
            } else {
              // No target pool - skip target stats (this is fine, we can show tables from source only)
            }

            const tableSubs = tableSubscriptions.get(tableName) || []; // This table's subscriptions (which subscriptions include this table)
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

                // Get rate of change from the new service
                let rateOfChange1Hour: number | null = null;
                let rateOfChange24Hour: number | null = null;
                
                const rateKey = `public.${table}`;
                const rateData = rateOfChangeMap.get(rateKey);
                
                if (rateData) {
                  // Use the pre-calculated rates from the service
                  rateOfChange1Hour = rateData.rateOfChange1Hour;
                  rateOfChange24Hour = rateData.rateOfChange24Hour;
                } else {
                  // Fallback to old calculation if no data in new system yet
                  const normalizedTable = table.toLowerCase();
                  const data1Hour = historical1Hour.get(normalizedTable);
                  const data24Hour = historical24Hour.get(normalizedTable);
                  
                  // Calculate 1-hour rate
                  if (data1Hour && data1Hour.sourceRowCount > 0 && sourceCount > 0) {
                    const now = new Date();
                    const timeDiffMs = now.getTime() - data1Hour.timestamp.getTime();
                    const timeDiffMinutes = timeDiffMs / (1000 * 60);
                    
                    if (timeDiffMinutes > 0) {
                      const rowChange = sourceCount - data1Hour.sourceRowCount;
                      rateOfChange1Hour = rowChange / timeDiffMinutes;
                    }
                  }
                  
                  // Calculate 24-hour rate
                  if (data24Hour && data24Hour.sourceRowCount > 0 && sourceCount > 0) {
                    const now = new Date();
                    const timeDiffMs = now.getTime() - data24Hour.timestamp.getTime();
                    const timeDiffMinutes = timeDiffMs / (1000 * 60);
                    
                    if (timeDiffMinutes > 0) {
                      const rowChange = sourceCount - data24Hour.sourceRowCount;
                      rateOfChange24Hour = rowChange / timeDiffMinutes;
                    }
                  }
                }

                // Store current metrics for future rate calculations
                // Use the first subscription's ID to store metrics for ALL tables (even if not in subscription)
                // This allows us to track metrics globally while respecting the NOT NULL constraint
                try {
                  const metricsIdColumnCheck = await monitoringPool.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_name = 'table_replication_metrics' 
                      AND column_name IN ('subscription_id', 'group_id')
                    LIMIT 1
                  `).catch(() => ({ rows: [] }));
                  
                  const metricsIdColumn = metricsIdColumnCheck.rows[0]?.column_name || 'subscription_id';
                  
                  // Get or create a "global" subscription ID for tracking all tables
                  // Use the global subscriptions list (not tableSubs which is just for this table)
                  // We need to reference the outer scope subscriptions variable
                  let subscriptionIdForMetrics: string | null = null;
                  
                  // Access the outer scope subscriptions variable (all subscriptions, not just this table's)
                  const allSubscriptions = subscriptionsResult.rows;
                  if (allSubscriptions && allSubscriptions.length > 0) {
                    subscriptionIdForMetrics = allSubscriptions[0].id;
                  } else {
                    // If subscriptions array is empty, query the database directly
                    // This handles the case where subscriptions weren't loaded or query failed
                    try {
                      const subCheck = await monitoringPool.query(`
                        SELECT id FROM subscriptions LIMIT 1
                      `).catch(() => ({ rows: [] }));
                      
                      if (subCheck.rows && subCheck.rows.length > 0) {
                        subscriptionIdForMetrics = subCheck.rows[0].id;
                      } else {
                        console.warn(`[tables/all] No subscriptions found in database. allSubscriptions array length: ${allSubscriptions?.length || 0}`);
                      }
                    } catch (err: any) {
                      console.error(`[tables/all] Error querying for subscriptions:`, err.message);
                    }
                  }
                  
                // Store metrics using the subscription ID (even if table is not in that subscription)
                // This allows us to track rate of change for all tables
                // If no subscriptions exist, we skip metrics storage (it's optional anyway)
                if (subscriptionIdForMetrics) {
                  const tableNameForStorage = table; // Store just the table name, not schema.table
                  await monitoringPool.query(`
                    INSERT INTO table_replication_metrics (
                      ${metricsIdColumn}, table_name, timestamp, source_row_count, target_row_count, gap_size, status
                    ) VALUES ($1, $2, date_trunc('minute', NOW()), $3, $4, $5, $6)
                    ON CONFLICT (${metricsIdColumn}, table_name, timestamp) DO UPDATE SET
                      source_row_count = EXCLUDED.source_row_count,
                      target_row_count = EXCLUDED.target_row_count,
                      gap_size = EXCLUDED.gap_size,
                      status = EXCLUDED.status
                  `, [
                    subscriptionIdForMetrics,
                    tableNameForStorage,
                    sourceCount,
                    targetCount,
                    sourceCount - targetCount,
                    sourceCount === targetCount ? 'synced' : sourceCount > targetCount ? 'lagging' : 'error',
                  ]).catch((err) => {
                    // Log but ignore - rate tracking is optional
                    console.warn(`[tables/all] Failed to store metrics for ${table}:`, err.message);
                  });
                }
                // Note: If no subscriptions exist, metrics tracking is disabled (this is fine - it's optional)
                } catch (err) {
                  // Ignore - rate tracking is optional
                  console.warn(`[tables/all] Error storing metrics for ${table}:`, err);
                }

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
                  goldskyIndexed,
                  goldskyPipeline,
                  services,
                  serviceDetails, // Detailed service write information
                  databaseLocation, // Which database this table is in
                  hasReplicationRisk, // ⚠️ CRITICAL: Writers on both sides = PK conflict risk
                  hasActiveWriters,
                  shouldReplicate, // ✅ Safe to replicate (only source writers or none)
                  writersOnSource: sourceWriters, // Services writing to AWS
                  writersOnTarget: targetWriters, // Services writing to GCP
                  writersOnBoth: hasWritersOnBothSides, // True if writers on both sides
                  isEstimate: useEstimate,
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
        
        tableStats.push(...batchResults);
        
        // Small delay between batches to avoid overwhelming the database
        if (i + BATCH_SIZE < tablesToProcess.length) {
          await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
        }
      }
      

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
      

      console.log(`[tables/all] ✓ Returning ${response.tables.length} tables`);
      console.log('[tables/all] ========== API Request Complete ==========');
      
      res.status(200).json(response);
    } finally {
      // Only close pools that were actually created
      if (sourcePool) await sourcePool.end().catch(() => {});
      if (targetPool) await targetPool.end().catch(() => {});
    }
  } catch (error: any) {
    console.error('[tables/all] ❌ ERROR:', error);
    console.error('[tables/all] Stack trace:', error.stack);
    console.log('[tables/all] ========== API Request Failed ==========');
    res.status(500).json({ error: error.message || 'Failed to get tables' });
  }
}

