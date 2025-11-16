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

  try {
    const pool = getDbPool();
    
    // Get subscription details
    const subResult = await pool.query(`
      SELECT * FROM subscriptions WHERE id = $1
    `, [id]);

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const subscription = subResult.rows[0];
    const sourcePool = createSourceTargetPool(subscription.source_db_connection);
    const targetPool = createSourceTargetPool(subscription.target_db_connection);
    
    // Get service write stats to determine which tables have writers
    const appTrackingService = new ApplicationTrackingService();
    const [sourceWriteStats, targetWriteStats] = await Promise.all([
      appTrackingService.getWriteStatsByApplication(sourcePool, 2).catch(() => []),
      appTrackingService.getWriteStatsByApplication(targetPool, 2).catch(() => []),
    ]);
    
    // Create maps of table -> writers
    const tableToSourceWriters = new Map<string, Set<string>>();
    const tableToTargetWriters = new Map<string, Set<string>>();
    
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

    try {
      // Get tables from publication
      const pubTablesResult = await sourcePool.query(`
        SELECT schemaname || '.' || tablename as table_name
        FROM pg_publication_tables
        WHERE pubname = $1
        ORDER BY tablename
      `, [subscription.publication_name]);

      const tables = pubTablesResult.rows.map((r: any) => r.table_name);

      // Get row counts for each table (from both source and target)
      // Use pg_class.reltuples for faster approximate counts on large tables
      // Process in batches to avoid overwhelming the database connection pool
      const BATCH_SIZE = 5; // Process 5 tables at a time to avoid connection exhaustion
      const tableStats = await processInBatches(
        tables,
        BATCH_SIZE,
        async (tableName: string) => {
          const [schema, table] = tableName.split('.');
          
          // Build properly quoted table name for queries
          const quotedTableName = `"${schema}"."${table}"`;
          
          try {
            // Try to get exact count, but use estimate for very large tables
            // For tables > 1M rows, use reltuples estimate
            const sourceEstimateResult = await sourcePool.query(`
              SELECT reltuples::bigint as estimate
              FROM pg_class
              WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
            `, [table, schema]).catch((err) => {
              console.error(`[subscriptions/${id}/tables] Estimate failed for ${table}:`, err.message);
              return { rows: [{ estimate: '0' }] };
            });
            
            const estimate = parseInt(sourceEstimateResult.rows[0]?.estimate || '0', 10);
            const useEstimate = estimate > 1000000; // Use estimate for tables > 1M rows
            
            let sourceCount: number;
            console.log(`[subscriptions/${id}/tables] Table ${table}: estimate=${estimate}, useEstimate=${useEstimate}`);
            if (useEstimate) {
              sourceCount = estimate;
            } else {
              // Get exact count for smaller tables (use quoted table name)
              const sourceCountResult = await sourcePool.query(`
                SELECT COUNT(*) as count
                FROM ${quotedTableName}
              `).catch((err) => {
                console.error(`[subscriptions/${id}/tables] Source count failed for ${quotedTableName}:`, err.message);
                return { rows: [{ count: '0' }] };
              });
              sourceCount = parseInt(sourceCountResult.rows[0]?.count || 0, 10);
            }

            // Get target row count (always try exact, fallback to estimate, use quoted name)
            const targetCountResult = await targetPool.query(`
              SELECT COUNT(*) as count
              FROM ${quotedTableName}
            `).catch((err) => {
              console.error(`[subscriptions/${id}/tables] Target count failed for ${quotedTableName}:`, err.message);
              // Fallback to estimate if exact count fails
              return targetPool.query(`
                SELECT reltuples::bigint as estimate
                FROM pg_class
                WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
              `, [table, schema]).then((r: any) => ({ rows: [{ count: r.rows[0]?.estimate || '0' }] }));
            });
            
            const targetCount = parseInt(targetCountResult.rows[0]?.count || '0', 10);

            // Get table size (use quoted table name)
            const sourceSizeResult = await sourcePool.query(`
              SELECT pg_total_relation_size($1::regclass) as size
            `, [quotedTableName]).catch((err) => {
              console.error(`[subscriptions/${id}/tables] Size query failed for ${quotedTableName}:`, err.message);
              return { rows: [{ size: '0' }] };
            });
            
            const sourceSize = parseInt(sourceSizeResult.rows[0]?.size || '0', 10);

            // Check if table has writers
            const tableKey = table.toLowerCase();
            const sourceWriters = Array.from(tableToSourceWriters.get(tableKey) || new Set());
            const targetWriters = Array.from(tableToTargetWriters.get(tableKey) || new Set());
            const hasWritersOnBothSides = sourceWriters.length > 0 && targetWriters.length > 0;
            const hasWritersOnSourceOnly = sourceWriters.length > 0 && targetWriters.length === 0;
            const hasNoWriters = sourceWriters.length === 0 && targetWriters.length === 0;
            
            // Safe to replicate if: only source writers OR no writers at all
            const isSafeToReplicate = hasWritersOnSourceOnly || hasNoWriters;
            const hasReplicationRisk = hasWritersOnBothSides;

            // Get historical row count to calculate rate of change
            // Check which column name exists (subscription_id or group_id)
            const metricsIdColumnCheck = await pool.query(`
              SELECT column_name 
              FROM information_schema.columns 
              WHERE table_name = 'table_replication_metrics' 
                AND column_name IN ('subscription_id', 'group_id')
              LIMIT 1
            `).catch(() => ({ rows: [] }));
            
            const metricsIdColumn = metricsIdColumnCheck.rows[0]?.column_name || 'subscription_id';
            
            // Get previous row count using the selected timeframe
            // Compare with data from at least 1 minute ago to avoid comparing with current measurement
            // Try both with and without schema prefix for table name matching
            const historicalResult = await pool.query(`
              SELECT 
                source_row_count,
                target_row_count,
                timestamp
              FROM table_replication_metrics
              WHERE ${metricsIdColumn} = $1
                AND (
                  table_name = $2
                  OR table_name = $3
                  OR REGEXP_REPLACE(table_name, '^[^.]+\.', '') = $2
                )
                AND timestamp < NOW() - INTERVAL '1 minute'
                AND timestamp > NOW() - INTERVAL '${timeframeMinutes} minutes'::text
                AND source_row_count IS NOT NULL
                AND source_row_count > 0
              ORDER BY timestamp DESC
              LIMIT 1
            `, [subscription.id, table, tableName]).catch((err) => {
              console.warn(`[subscriptions/${id}/tables] Historical query failed for ${table}:`, err.message);
              return { rows: [] };
            });

            let rateOfChange: number | null = null;
            let rateOfChangeInterval: string = '';
            
            if (historicalResult.rows.length > 0) {
              const prevSourceCount = parseInt(historicalResult.rows[0].source_row_count || '0', 10);
              const prevTimestamp = new Date(historicalResult.rows[0].timestamp);
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
                
                console.log(`[subscriptions/${id}/tables] Rate of change for ${table}: ${ratePerMinute.toFixed(2)} rows/min (${rowChange} rows in ${timeDiffMinutes.toFixed(1)} min)`);
              }
            } else {
              console.log(`[subscriptions/${id}/tables] No historical data found for ${table} (subscription: ${subscription.id})`);
            }

            // Store current metrics for future rate calculations
            // Round timestamp to nearest minute to avoid constraint conflicts
            await pool.query(`
              INSERT INTO table_replication_metrics (
                ${metricsIdColumn}, table_name, timestamp, source_row_count, target_row_count, gap_size, status
              ) VALUES ($1, $2, date_trunc('minute', NOW()), $3, $4, $5, $6)
              ON CONFLICT (${metricsIdColumn}, table_name, timestamp) DO UPDATE SET
                source_row_count = EXCLUDED.source_row_count,
                target_row_count = EXCLUDED.target_row_count,
                gap_size = EXCLUDED.gap_size,
                status = EXCLUDED.status
            `, [
              subscription.id,
              table,
              sourceCount,
              targetCount,
              sourceCount - targetCount,
              sourceCount === targetCount ? 'synced' : sourceCount > targetCount ? 'lagging' : 'error',
            ]).catch(() => {
              // Fallback for old schema
              return pool.query(`
                INSERT INTO table_replication_metrics (
                  group_id, table_name, timestamp, source_row_count, target_row_count, gap_size, status
                ) VALUES ($1, $2, date_trunc('minute', NOW()), $3, $4, $5, $6)
                ON CONFLICT (group_id, table_name, timestamp) DO UPDATE SET
                  source_row_count = EXCLUDED.source_row_count,
                  target_row_count = EXCLUDED.target_row_count,
                  gap_size = EXCLUDED.gap_size,
                  status = EXCLUDED.status
              `, [
                subscription.id,
                table,
                sourceCount,
                targetCount,
                sourceCount - targetCount,
                sourceCount === targetCount ? 'synced' : sourceCount > targetCount ? 'lagging' : 'error',
              ]);
            }).catch(() => {
              // Ignore if table doesn't exist or constraint issues
            });

            // Determine status based on replication state and row counts
            // During initial copy, target can be ahead of source (source cleanup, deletions)
            // Only mark as error if source query failed (sourceCount = 0 and target > 0)
            let status: string;
            if (sourceCount === 0 && targetCount > 0) {
              // Source query likely failed - checking replication state
              status = 'checking';
            } else if (sourceCount === targetCount) {
              status = 'synced';
            } else if (Math.abs(sourceCount - targetCount) < 100) {
              // Within 100 rows tolerance = synced (accounts for concurrent writes)
              status = 'synced';
            } else if (sourceCount > targetCount) {
              // Source ahead - normal during copy
              status = 'lagging';
            } else {
              // Target ahead - can happen with source deletions or during copy
              // Check if difference is shrinking (rate of change)
              if (rateOfChange !== null && rateOfChange < 0) {
                // Source is shrinking (deletions) - this is OK
                status = 'synced';
              } else {
                // Target ahead but source not shrinking - needs investigation
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
              sourceSize,
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
              schema,
              table,
              sourceRowCount: 0,
              targetRowCount: 0,
              rowDiff: 0,
              sourceSize: 0,
              status: 'error',
              error: error.message,
            };
          }
        }
      );

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
    console.error('Error getting subscription tables:', error);
    res.status(500).json({ error: error.message || 'Failed to get subscription tables' });
  }
}

