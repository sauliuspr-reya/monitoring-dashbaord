import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { ApplicationTrackingService } from '@/lib/services/application-tracking.service';
import { processInBatches } from '@/lib/utils/batch';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id, timeframe } = req.query;
  
  // Parse timeframe: '1m', '5m', '10m', '1h', '6h', '24h', etc.
  // Default to 1 hour if not specified
  let timeframeMinutes = 60; // default 1 hour
  if (timeframe) {
    const timeframeStr = String(timeframe).toLowerCase();
    if (timeframeStr.endsWith('m')) {
      timeframeMinutes = parseInt(timeframeStr.slice(0, -1)) || 60;
    } else if (timeframeStr.endsWith('h')) {
      timeframeMinutes = (parseInt(timeframeStr.slice(0, -1)) || 1) * 60;
    } else if (timeframeStr.endsWith('d')) {
      timeframeMinutes = (parseInt(timeframeStr.slice(0, -1)) || 1) * 24 * 60;
    }
  }
  
  // Minimum 1 minute, maximum 7 days
  timeframeMinutes = Math.max(1, Math.min(timeframeMinutes, 7 * 24 * 60));

  const startTime = Date.now();
  console.log(`[subscriptions/${id}/tables] Starting request at ${new Date().toISOString()}`);

  try {
    const pool = getDbPool();
    
    // Get subscription details
    const step1Start = Date.now();
    const subResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [id]);
    console.log(`[subscriptions/${id}/tables] Step 1 (subscription lookup): ${Date.now() - step1Start}ms`);

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const subscription = subResult.rows[0];
    const sourcePool = createSourceTargetPool(subscription.source_db_connection);
    const targetPool = createSourceTargetPool(subscription.target_db_connection);
    
    // OPTIMIZATION: Make application tracking optional - it's slow and queries pg_stat_activity/pg_stat_statements
    // Only fetch if explicitly requested via query param
    const includeWriters = req.query.includeWriters === 'true';
    const tableToSourceWriters = new Map<string, Set<string>>();
    const tableToTargetWriters = new Map<string, Set<string>>();
    
    if (includeWriters) {
      console.log(`[subscriptions/${id}/tables] Fetching application write stats (slow operation)`);
      try {
    // Get service write stats to determine which tables have writers
    const appTrackingService = new ApplicationTrackingService();
    const [sourceWriteStats, targetWriteStats] = await Promise.all([
      appTrackingService.getWriteStatsByApplication(sourcePool, 2).catch(() => []),
      appTrackingService.getWriteStatsByApplication(targetPool, 2).catch(() => []),
    ]);
    
    // Create maps of table -> writers
    for (const stat of sourceWriteStats) {
      const tableKey = stat.table.toLowerCase();
      if (!tableToSourceWriters.has(tableKey)) {
        tableToSourceWriters.set(tableKey, new Set());
      }
      tableToSourceWriters.get(tableKey)!.add(stat.applicationName);
    }
    
    for (const stat of targetWriteStats) {
      const tableKey = stat.table.toLowerCase();
      if (!tableToTargetWriters.has(tableKey)) {
        tableToTargetWriters.set(tableKey, new Set());
      }
      tableToTargetWriters.get(tableKey)!.add(stat.applicationName);
        }
        console.log(`[subscriptions/${id}/tables] Found ${sourceWriteStats.length} source writers, ${targetWriteStats.length} target writers`);
      } catch (err: any) {
        console.warn(`[subscriptions/${id}/tables] Failed to fetch application write stats:`, err.message);
        // Continue without writer info - not critical
      }
    } else {
      console.log(`[subscriptions/${id}/tables] Skipping application write stats (use ?includeWriters=true to enable)`);
    }

    try {
      // Get tables from publication
      const step2Start = Date.now();
      const pubTablesResult = await sourcePool.query(`
        SELECT schemaname || '.' || tablename as table_name
        FROM pg_publication_tables
        WHERE pubname = $1
        ORDER BY tablename
      `, [subscription.publication_name]);

      const tables = pubTablesResult.rows.map((r: any) => r.table_name);
      console.log(`[subscriptions/${id}/tables] Step 2 (get publication tables): ${Date.now() - step2Start}ms - Found ${tables.length} tables`);

      // OPTIMIZATION: Fetch ALL table stats in bulk queries (like /api/tables/all does)
      // This reduces from 5 queries per table to 2 bulk queries + only COUNT(*) for small tables
      
      // Step 1: Get ALL source table estimates and sizes in ONE query
      // Include separate metrics for table size, index size, and total size
      const step3Start = Date.now();
      const sourceStatsMap = new Map<string, { estimate: number; tableSize: number; indexSize: number; totalSize: number }>();
      try {
        const sourceStatsResult = await sourcePool.query(`
          SELECT 
            n.nspname || '.' || c.relname as table_name,
            COALESCE(s.n_live_tup::bigint, c.reltuples::bigint, 0) as estimated_rows,
            pg_relation_size(c.oid) as table_size,
            pg_indexes_size(c.oid) as index_size,
            pg_total_relation_size(c.oid) as total_size
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid AND s.schemaname = n.nspname
          WHERE c.relkind = 'r'
            AND n.nspname || '.' || c.relname = ANY($1)
        `, [tables]);
        
        for (const row of sourceStatsResult.rows) {
          sourceStatsMap.set(row.table_name, {
            estimate: parseInt(row.estimated_rows || '0', 10),
            tableSize: parseInt(row.table_size || '0', 10),
            indexSize: parseInt(row.index_size || '0', 10),
            totalSize: parseInt(row.total_size || '0', 10),
          });
        }
        console.log(`[subscriptions/${id}/tables] Step 3 (source bulk stats): ${Date.now() - step3Start}ms - Fetched ${sourceStatsMap.size} tables`);
      } catch (err: any) {
        console.error(`[subscriptions/${id}/tables] Failed to fetch bulk source stats:`, err.message);
      }

      // Step 2: Get ALL target table estimates and sizes in ONE query
      const step4Start = Date.now();
      const targetStatsMap = new Map<string, { estimate: number; tableSize: number; indexSize: number; totalSize: number }>();
      try {
        const targetStatsResult = await targetPool.query(`
          SELECT 
            n.nspname || '.' || c.relname as table_name,
            COALESCE(s.n_live_tup::bigint, c.reltuples::bigint, 0) as estimated_rows,
            pg_relation_size(c.oid) as table_size,
            pg_indexes_size(c.oid) as index_size,
            pg_total_relation_size(c.oid) as total_size
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid AND s.schemaname = n.nspname
          WHERE c.relkind = 'r'
            AND n.nspname || '.' || c.relname = ANY($1)
        `, [tables]);
        
        for (const row of targetStatsResult.rows) {
          targetStatsMap.set(row.table_name, {
            estimate: parseInt(row.estimated_rows || '0', 10),
            tableSize: parseInt(row.table_size || '0', 10),
            indexSize: parseInt(row.index_size || '0', 10),
            totalSize: parseInt(row.total_size || '0', 10),
          });
        }
        console.log(`[subscriptions/${id}/tables] Step 4 (target bulk stats): ${Date.now() - step4Start}ms - Fetched ${targetStatsMap.size} tables`);
      } catch (err: any) {
        console.error(`[subscriptions/${id}/tables] Failed to fetch bulk target stats:`, err.message);
      }

      // Step 3: Use estimates for ALL tables - COUNT(*) is too expensive
      const step5Start = Date.now();
      // Only use exact counts for very small tables (< 100K rows) that are likely to be accurate
      // For production, estimates are good enough - exact counts kill performance
      const tablesNeedingExactCount: string[] = [];
      for (const tableName of tables) {
        const sourceStats = sourceStatsMap.get(tableName);
        // Only get exact count for very small tables (< 100K) where estimate might be inaccurate
        // AND where the table is likely to be fully synced (small = fast to count)
        if (sourceStats && sourceStats.estimate < 100000 && sourceStats.estimate > 0) {
          tablesNeedingExactCount.push(tableName);
        }
      }
      console.log(`[subscriptions/${id}/tables] Step 5 (identify small tables): ${Date.now() - step5Start}ms - Using estimates for ${tables.length - tablesNeedingExactCount.length} tables, exact COUNT(*) for ${tablesNeedingExactCount.length} small tables only`);

      // Step 4: Get exact counts for VERY small tables only (in small batches to avoid overload)
      const step6Start = Date.now();
      const exactCountsMap = new Map<string, { source: number; target: number }>();
      if (tablesNeedingExactCount.length > 0) {
        // Use smaller batches to avoid overwhelming the database
        const BATCH_SIZE = 3; // Very conservative - COUNT(*) is expensive
        console.log(`[subscriptions/${id}/tables] Getting exact counts for ${tablesNeedingExactCount.length} small tables in batches of ${BATCH_SIZE}`);
        
        await processInBatches(
          tablesNeedingExactCount,
          BATCH_SIZE,
          async (tableName: string) => {
            const [schema, table] = tableName.split('.');
            const quotedTableName = `"${schema}"."${table}"`;
            
            try {
              // COUNT(*) queries with timeout protection
              const [sourceResult, targetResult] = await Promise.all([
                sourcePool.query(`SELECT COUNT(*) as count FROM ${quotedTableName}`).catch(() => ({ rows: [{ count: '0' }] })),
                targetPool.query(`SELECT COUNT(*) as count FROM ${quotedTableName}`).catch(() => ({ rows: [{ count: '0' }] })),
              ]);
              
              exactCountsMap.set(tableName, {
                source: parseInt(sourceResult.rows[0]?.count || '0', 10),
                target: parseInt(targetResult.rows[0]?.count || '0', 10),
              });
            } catch (err: any) {
              console.warn(`[subscriptions/${id}/tables] Failed to get exact count for ${tableName}:`, err.message);
              // Fallback to estimate if COUNT(*) fails
              const sourceStats = sourceStatsMap.get(tableName);
              const targetStats = targetStatsMap.get(tableName);
              exactCountsMap.set(tableName, {
                source: sourceStats?.estimate || 0,
                target: targetStats?.estimate || 0,
              });
            }
          }
        );
        console.log(`[subscriptions/${id}/tables] Step 6 (exact counts): ${Date.now() - step6Start}ms - Fetched exact counts for ${exactCountsMap.size} tables`);
      }

      // Step 5: Get historical metrics in bulk (one query for all tables)
      const step7Start = Date.now();
      const metricsIdColumnCheck = await pool.query(`
              SELECT column_name 
              FROM information_schema.columns 
              WHERE table_name = 'table_replication_metrics' 
                AND column_name IN ('subscription_id', 'group_id')
              LIMIT 1
            `).catch(() => ({ rows: [] }));
            
            const metricsIdColumn = metricsIdColumnCheck.rows[0]?.column_name || 'subscription_id';
      const timeframeMinutes = req.query.timeframe === '1m' ? 1 : 
                               req.query.timeframe === '5m' ? 5 :
                               req.query.timeframe === '10m' ? 10 :
                               req.query.timeframe === '30m' ? 30 :
                               req.query.timeframe === '6h' ? 360 :
                               req.query.timeframe === '24h' ? 1440 : 60;

      const historicalMetricsMap = new Map<string, { sourceRowCount: number; timestamp: Date }>();
      try {
            const historicalResult = await pool.query(`
          SELECT DISTINCT ON (table_name)
            table_name,
                source_row_count,
                timestamp
              FROM table_replication_metrics
              WHERE ${metricsIdColumn} = $1
            AND table_name = ANY($2)
                AND timestamp < NOW() - INTERVAL '1 minute'
                AND timestamp > NOW() - INTERVAL '${timeframeMinutes} minutes'::text
                AND source_row_count IS NOT NULL
                AND source_row_count > 0
          ORDER BY table_name, timestamp DESC
        `, [subscription.id, tables.map(t => t.split('.')[1])]); // Use just table name without schema
        
        for (const row of historicalResult.rows) {
          historicalMetricsMap.set(row.table_name.toLowerCase(), {
            sourceRowCount: parseInt(row.source_row_count || '0', 10),
            timestamp: new Date(row.timestamp),
          });
        }
        console.log(`[subscriptions/${id}/tables] Step 7 (historical metrics): ${Date.now() - step7Start}ms - Fetched historical metrics for ${historicalMetricsMap.size} tables`);
      } catch (err: any) {
        console.warn(`[subscriptions/${id}/tables] Failed to fetch historical metrics:`, err.message);
      }

      // Step 6: Build table stats from bulk data
      const step8Start = Date.now();
      let processedCount = 0;
      const tableStats = tables.map((tableName: string) => {
        processedCount++;
        if (processedCount % 20 === 0) {
          console.log(`[subscriptions/${id}/tables] Processed ${processedCount}/${tables.length} tables...`);
        }
        
        const [schema, table] = tableName.split('.');
        const tableKey = table.toLowerCase();
        
        try {
          // Get stats from bulk queries
          const sourceStats = sourceStatsMap.get(tableName) || { estimate: 0, tableSize: 0, indexSize: 0, totalSize: 0 };
          const targetStats = targetStatsMap.get(tableName) || { estimate: 0, tableSize: 0, indexSize: 0, totalSize: 0 };
          const exactCounts = exactCountsMap.get(tableName);
          
          // Use exact count if available, otherwise use estimate
          // NOTE: reltuples estimates can be stale after restore - run ANALYZE to update them
          const sourceCount = exactCounts?.source ?? sourceStats.estimate;
          const targetCount = exactCounts?.target ?? targetStats.estimate;
          
          // Size metrics: separate table size, index size, and total
          const sourceTableSize = sourceStats.tableSize || 0;
          const sourceIndexSize = sourceStats.indexSize || 0;
          const sourceTotalSize = sourceStats.totalSize || 0;
          const targetTableSize = targetStats.tableSize || 0;
          const targetIndexSize = targetStats.indexSize || 0;
          const targetTotalSize = targetStats.totalSize || 0;
          
          // Mark as estimate if we didn't get exact count (most tables use estimates)
          const useEstimate = !exactCounts;

          // Check if table has writers
          const sourceWriters = Array.from(tableToSourceWriters.get(tableKey) || new Set());
          const targetWriters = Array.from(tableToTargetWriters.get(tableKey) || new Set());
          const hasWritersOnBothSides = sourceWriters.length > 0 && targetWriters.length > 0;
          const hasWritersOnSourceOnly = sourceWriters.length > 0 && targetWriters.length === 0;
          const hasNoWriters = sourceWriters.length === 0 && targetWriters.length === 0;
          
          // Safe to replicate if: only source writers OR no writers at all
          const isSafeToReplicate = hasWritersOnSourceOnly || hasNoWriters;
          const hasReplicationRisk = hasWritersOnBothSides;

          // Get historical data from bulk query (already fetched in Step 5)
          const historicalData = historicalMetricsMap.get(tableKey);
            let rateOfChange: number | null = null;
            let rateOfChangeInterval: string = '';
            
          if (historicalData) {
            const prevSourceCount = historicalData.sourceRowCount;
            const prevTimestamp = historicalData.timestamp;
              const now = new Date();
              const timeDiffMs = now.getTime() - prevTimestamp.getTime();
              const timeDiffMinutes = timeDiffMs / (1000 * 60);
              
              if (timeDiffMinutes > 0 && prevSourceCount > 0) {
                const rowChange = sourceCount - prevSourceCount;
                const ratePerMinute = rowChange / timeDiffMinutes;
                rateOfChange = ratePerMinute;
                
                // Format interval
                if (timeDiffMinutes < 60) {
                  rateOfChangeInterval = `${Math.round(timeDiffMinutes)}m`;
                } else {
                  const hours = Math.round(timeDiffMinutes / 60);
                  rateOfChangeInterval = `${hours}h`;
                }
            }
          }

            // Determine status based on replication state and row counts
            let status: string;
            if (sourceCount === 0 && targetCount > 0) {
              status = 'checking';
            } else if (sourceCount === targetCount) {
              status = 'synced';
            } else if (Math.abs(sourceCount - targetCount) < 100) {
              status = 'synced';
            } else if (sourceCount > targetCount) {
              status = 'lagging';
            } else {
              if (rateOfChange !== null && rateOfChange < 0) {
                status = 'synced';
              } else {
                status = 'warning';
              }
            }

            return {
              tableName,
              schema,
              table,
              sourceRowCount: sourceCount,
              targetRowCount: targetCount,
              rowDiff: sourceCount - targetCount,
              sourceTableSize,
              sourceIndexSize,
              sourceTotalSize,
              targetTableSize,
              targetIndexSize,
              targetTotalSize,
              status,
              isEstimate: useEstimate,
              writersOnSource: sourceWriters,
              writersOnTarget: targetWriters,
              writersOnBoth: hasWritersOnBothSides,
              isSafeToReplicate,
              hasReplicationRisk,
              rateOfChange,
              rateOfChangeInterval,
            };
          } catch (error: any) {
            return {
              tableName,
            schema: tableName.split('.')[0],
            table: tableName.split('.')[1] || tableName,
              sourceRowCount: 0,
              targetRowCount: 0,
              rowDiff: 0,
              sourceTableSize: 0,
              sourceIndexSize: 0,
              sourceTotalSize: 0,
              targetTableSize: 0,
              targetIndexSize: 0,
              targetTotalSize: 0,
              status: 'error',
              error: error.message,
              isEstimate: true,
            };
          }
      });

      // Step 7: Store metrics in bulk (ASYNC - don't wait, return response immediately)
      // Metrics storage is non-critical and can happen in background
      const METRICS_BATCH_SIZE = 20;
      const metricsToStore = tableStats.map(stat => ({
        subscriptionId: subscription.id,
        tableName: stat.table,
        sourceRowCount: stat.sourceRowCount,
        targetRowCount: stat.targetRowCount,
        gapSize: stat.rowDiff,
        status: stat.status,
      }));

      // Store metrics asynchronously (fire and forget)
      Promise.all(
        Array.from({ length: Math.ceil(metricsToStore.length / METRICS_BATCH_SIZE) }, (_, i) => {
          const batch = metricsToStore.slice(i * METRICS_BATCH_SIZE, (i + 1) * METRICS_BATCH_SIZE);
          return Promise.all(
            batch.map(metric =>
              pool.query(`
                INSERT INTO table_replication_metrics (
                  ${metricsIdColumn}, table_name, timestamp, source_row_count, target_row_count, gap_size, status
                ) VALUES ($1, $2, date_trunc('minute', NOW()), $3, $4, $5, $6)
                ON CONFLICT (${metricsIdColumn}, table_name, timestamp) DO UPDATE SET
                  source_row_count = EXCLUDED.source_row_count,
                  target_row_count = EXCLUDED.target_row_count,
                  gap_size = EXCLUDED.gap_size,
                  status = EXCLUDED.status
              `, [
                metric.subscriptionId,
                metric.tableName,
                metric.sourceRowCount,
                metric.targetRowCount,
                metric.gapSize,
                metric.status,
              ]).catch(() => {
                // Ignore if table doesn't exist or constraint issues
              })
            )
          );
        })
      ).catch(err => {
        console.warn(`[subscriptions/${id}/tables] Failed to store metrics (non-critical):`, err.message);
      });

      console.log(`[subscriptions/${id}/tables] Step 8 (build stats): ${Date.now() - step8Start}ms - Built stats for ${tableStats.length} tables`);
      console.log(`[subscriptions/${id}/tables] TOTAL TIME: ${Date.now() - startTime}ms (metrics storage in background)`);

      const safeTables = tableStats.filter(t => t.isSafeToReplicate).length;
      const atRiskTables = tableStats.filter(t => t.hasReplicationRisk).length;
      
      res.status(200).json({
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        tables: tableStats,
        totalTables: tableStats.length,
        syncedTables: tableStats.filter(t => t.status === 'synced').length,
        laggingTables: tableStats.filter(t => t.status === 'lagging').length,
        errorTables: tableStats.filter(t => t.status === 'error').length,
        safeTables,
        atRiskTables,
      });
    } finally {
      await sourcePool.end().catch(() => {});
      await targetPool.end().catch(() => {});
    }
  } catch (error: any) {
    console.error('[subscriptions/tables] Error getting subscription tables:', error);
    console.error('[subscriptions/tables] Error stack:', error.stack);
    res.status(500).json({ 
      error: error.message || 'Failed to get subscription tables',
      details: error.stack || 'No additional details available'
    });
  }
}

