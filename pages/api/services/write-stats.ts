import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { ApplicationTrackingService } from '@/lib/services/application-tracking.service';
import { GoldskyAnalysisService } from '@/lib/services/goldsky-analysis.service';

interface DatabaseLocation {
  type: 'source' | 'target';
  provider: 'aws' | 'gcp' | 'unknown';
  host?: string;
  label: string;
}

/**
 * Detect database provider and location from connection string
 */
function detectDatabaseLocation(connectionString: string, type: 'source' | 'target'): DatabaseLocation {
  try {
    const url = new URL(connectionString);
    const host = url.hostname;
    
    // Detect provider from hostname, IP address patterns, or connection string
    let provider: 'aws' | 'gcp' | 'unknown' = 'unknown';
    
    // Check for AWS RDS patterns
    if (
      host.includes('.rds.amazonaws.com') || 
      host.includes('.rds.') || 
      host.match(/^[a-z0-9-]+\.rds\./) ||
      host.match(/^[a-z0-9-]+\.rds-[a-z0-9-]+\.amazonaws\.com/)
    ) {
      provider = 'aws';
    } 
    // Check for GCP Cloud SQL patterns
    else if (
      host.includes('.sql') || 
      host.includes('cloudsql') || 
      host.includes('gcp') ||
      host.includes('cloud.google.com') ||
      host.match(/.*\.cloudsql\.proj.*/)
    ) {
      provider = 'gcp';
    }
    // For IP addresses or unknown hostnames, use type-based heuristic
    // Source is typically AWS RDS, Target is typically GCP Cloud SQL
    else {
      provider = type === 'source' ? 'aws' : 'gcp';
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
    // Fallback: use type-based default
    const provider = type === 'source' ? 'aws' : 'gcp';
    return {
      type,
      provider,
      label: type === 'source' ? 'Source (AWS RDS)' : 'Target (GCP Cloud SQL)',
    };
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { groupId, tableName, hours = '2' } = req.query;
  const hoursNum = parseInt(hours as string, 10) || 2;

  try {
    const pool = getDbPool();
    
    let sourcePool;
    let targetPool;
    let sourceConnectionString = '';
    let targetConnectionString = '';
    
    if (groupId) {
      // Get specific subscription
      const groupResult = await pool.query(`
        SELECT * FROM subscriptions WHERE id = $1
      `, [groupId]);

      if (groupResult.rows.length === 0) {
        return res.status(404).json({ error: 'Group not found' });
      }

      const group = groupResult.rows[0];
      sourceConnectionString = group.source_db_connection;
      targetConnectionString = group.target_db_connection;
      sourcePool = createSourceTargetPool(sourceConnectionString);
      targetPool = createSourceTargetPool(targetConnectionString);
    } else {
      // Get all subscriptions and use the first one's databases
      // (assuming they all use the same source/target)
      const subscriptionsResult = await pool.query(`
        SELECT id, name, source_db_connection, target_db_connection
        FROM subscriptions
        ORDER BY name
        LIMIT 1
      `);

      if (subscriptionsResult.rows.length === 0) {
        // Try environment variables as fallback
        const envSource = process.env.SOURCE_DATABASE_URL;
        const envTarget = process.env.TARGET_DATABASE_URL;
        
        if (envSource && envTarget) {
          sourceConnectionString = envSource;
          targetConnectionString = envTarget;
          sourcePool = createSourceTargetPool(sourceConnectionString);
          targetPool = createSourceTargetPool(targetConnectionString);
        } else {
          return res.status(200).json({ 
            stats: [],
            byApplication: {},
            byTable: {},
            hours: hoursNum,
            sourceLocation: null,
            targetLocation: null,
            databaseLocations: [],
            message: 'No subscriptions found and no environment variables set. Please create a subscription or set SOURCE_DATABASE_URL and TARGET_DATABASE_URL.'
          });
        }
      }

      const firstSub = subscriptionsResult.rows[0];
      sourceConnectionString = firstSub.source_db_connection;
      targetConnectionString = firstSub.target_db_connection;
      
      if (!sourceConnectionString || !targetConnectionString) {
        return res.status(400).json({ 
          error: 'Database connection strings not found',
          message: 'The subscription is missing source_db_connection or target_db_connection',
          stats: [],
          byApplication: {},
          byTable: {},
          hours: hoursNum
        });
      }
      
      sourcePool = createSourceTargetPool(sourceConnectionString);
      targetPool = createSourceTargetPool(targetConnectionString);
    }

    // Detect database locations
    const sourceLocation = sourceConnectionString ? detectDatabaseLocation(sourceConnectionString, 'source') : null;
    const targetLocation = targetConnectionString ? detectDatabaseLocation(targetConnectionString, 'target') : null;

    if (!sourcePool || !targetPool) {
      return res.status(500).json({ 
        error: 'Failed to create database connections',
        stats: [],
        byApplication: {},
        byTable: {},
        hours: hoursNum
      });
    }

    try {
      const appTracking = new ApplicationTrackingService();
      const goldskyAnalysis = new GoldskyAnalysisService();

      // Get write stats from BOTH source and target databases
      const sourceStatsPromise = sourcePool 
        ? appTracking.getWriteStatsByApplication(sourcePool, hoursNum).catch((err) => {
            console.error('[write-stats] Error getting source stats:', err);
            return [];
          })
        : Promise.resolve([]);
      
      const targetStatsPromise = targetPool 
        ? appTracking.getWriteStatsByApplication(targetPool, hoursNum).catch((err) => {
            console.error('[write-stats] Error getting target stats:', err);
            return [];
          })
        : Promise.resolve([]);
      
      const [sourceStats, targetStats] = await Promise.all([
        sourceStatsPromise,
        targetStatsPromise,
      ]);
      
      // Debug: Log found services for troubleshooting
      const sourceServices = new Set(sourceStats.map(s => s.applicationName));
      const targetServices = new Set(targetStats.map(s => s.applicationName));
      console.log(`[write-stats] Source services (${sourceServices.size}):`, Array.from(sourceServices).join(', '));
      console.log(`[write-stats] Target services (${targetServices.size}):`, Array.from(targetServices).join(', '));
      
      // Tag stats with their database location (no suffix in display name)
      const sourceStatsTagged = sourceStats.map(stat => {
        return {
          ...stat,
          databaseLocation: sourceLocation,
          displayName: stat.applicationName, // No suffix - just the service name
          originalApplicationName: stat.applicationName, // Keep original for filtering
        };
      });
      
      const targetStatsTagged = targetStats.map(stat => {
        return {
          ...stat,
          databaseLocation: targetLocation,
          displayName: stat.applicationName, // No suffix - just the service name
          originalApplicationName: stat.applicationName, // Keep original for filtering
        };
      });
      
      // Combine stats from both databases
      const writeStats = [...sourceStatsTagged, ...targetStatsTagged];
      
      // Get Goldsky tables
      const goldskyTables = await goldskyAnalysis.getGoldskyTables();
      const goldskyPipelines = await goldskyAnalysis.parsePipelines();

      // Filter by table if specified
      let filteredStats = writeStats;
      if (tableName) {
        filteredStats = writeStats.filter((s) => s.table === tableName);
      }

      // Enrich with Goldsky info and normalize application names
      const enrichedStats = filteredStats.map((stat) => {
        const isGoldsky = goldskyTables.has(stat.table);
        const pipeline = goldskyPipelines.find((p) => p.tables.includes(stat.table));

        // Map "PostgreSQL JDBC Driver" to "Goldsky" if writing to a Goldsky table
        let applicationName = stat.originalApplicationName || stat.applicationName;
        if (
          (applicationName === 'PostgreSQL JDBC Driver' || 
           applicationName?.toLowerCase().includes('jdbc')) &&
          isGoldsky
        ) {
          applicationName = 'Goldsky';
        }

        // Use application name as display name (no suffix)
        const displayName = stat.displayName || applicationName;

        return {
          ...stat,
          applicationName: displayName, // Use displayName as the main identifier
          originalApplicationName: applicationName, // Keep original for reference
          displayName, // Ensure displayName is set
          isGoldskyTable: isGoldsky,
          goldskyPipeline: pipeline?.name || null,
        };
      });

      // Filter out placeholder entries (services with no writes) before grouping
      const statsWithWrites = enrichedStats.filter(stat => 
        stat.table !== '<no-recent-writes>' && stat.count > 0
      );
      
      // Group by application (only services with writes)
      const byApplication = new Map<string, typeof statsWithWrites>();
      for (const stat of statsWithWrites) {
        // Use displayName for grouping
        const key = stat.displayName || stat.applicationName;
        if (!byApplication.has(key)) {
          byApplication.set(key, []);
        }
        byApplication.get(key)!.push(stat);
      }

      // Group by table (only tables with writes)
      const byTable = new Map<string, typeof statsWithWrites>();
      for (const stat of statsWithWrites) {
        if (!byTable.has(stat.table)) {
          byTable.set(stat.table, []);
        }
        byTable.get(stat.table)!.push(stat);
      }
      
      const response = {
        stats: statsWithWrites, // Only services with actual writes
        sourceLocation: sourceLocation || null, // Source database location (AWS RDS)
        targetLocation: targetLocation || null, // Target database location (GCP Cloud SQL)
        databaseLocations: [sourceLocation, targetLocation].filter(Boolean), // Both locations
        byApplication: Object.fromEntries(
          Array.from(byApplication.entries()).map(([app, stats]) => [
            app,
            {
              totalWrites: stats.reduce((sum, s) => sum + s.count, 0),
              tables: Array.from(new Set(stats.map((s) => s.table))),
              operations: Array.from(new Set(stats.map((s) => s.operation))),
            },
          ])
        ),
        byTable: Object.fromEntries(
          Array.from(byTable.entries()).map(([table, stats]) => [
            table,
            {
              totalWrites: stats.reduce((sum, s) => sum + s.count, 0),
              services: Array.from(new Set(stats.map((s) => s.applicationName))),
              operations: Array.from(new Set(stats.map((s) => s.operation))),
              isGoldsky: goldskyTables.has(table),
              goldskyPipeline: goldskyPipelines.find((p) => p.tables.includes(table))?.name || null,
            },
          ])
        ),
        hours: hoursNum,
      };
      
      res.status(200).json(response);
    } catch (innerError) {
      console.error('[write-stats] Error in try block:', innerError);
      throw innerError; // Re-throw to be caught by outer catch
    } finally {
      if (sourcePool) await sourcePool.end().catch(() => {});
      if (targetPool) await targetPool.end().catch(() => {});
    }
  } catch (error) {
    console.error('[write-stats] Error getting write stats:', error);
    res.status(500).json({ 
      error: 'Failed to get write stats',
      message: error instanceof Error ? error.message : String(error),
      stats: [],
      byApplication: {},
      byTable: {},
      hours: hoursNum,
      sourceLocation: null,
      targetLocation: null,
      databaseLocations: []
    });
  }
}

