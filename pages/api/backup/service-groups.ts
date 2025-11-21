import type { NextApiRequest, NextApiResponse } from 'next';
import { createSourceTargetPool } from '@/lib/db/connection';

/**
 * API endpoint to get backup groups organized by service
 * Groups tables by which service owns them based on write activity
 */

interface ServiceGroup {
  serviceName: string;
  tables: string[];
  totalSize?: string;
  sizeBytes?: number;
}

interface UngroupedTables {
  tables: string[];
  totalSize?: string;
  sizeBytes?: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { connectionString, hours = 24, minWrites = 5 } = req.query;

  if (!connectionString) {
    return res.status(400).json({ error: 'connectionString is required' });
  }

  const sourcePool = createSourceTargetPool(connectionString as string);

  try {
    // Step 1: Get all tables with their sizes
    const allTablesResult = await sourcePool.query(`
      SELECT 
        schemaname,
        tablename,
        schemaname || '.' || tablename as full_table_name,
        pg_total_relation_size(schemaname || '.' || tablename) as size_bytes,
        pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as size_human
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
    `);

    // Step 2: Get write activity by service (last N hours)
    const serviceWritesResult = await sourcePool.query(`
      SELECT 
        application_name,
        schemaname || '.' || tablename as full_table_name,
        COUNT(*) as write_count,
        MAX(query_start) as last_write_time
      FROM pg_stat_activity
      WHERE 
        application_name IS NOT NULL 
        AND application_name != ''
        AND schemaname IS NOT NULL
        AND tablename IS NOT NULL
        AND schemaname NOT IN ('pg_catalog', 'information_schema')
        AND query_start > NOW() - INTERVAL '${hours} hours'
        AND query LIKE ANY(ARRAY['INSERT%', 'UPDATE%', 'DELETE%', 'COPY%'])
      GROUP BY application_name, schemaname, tablename
      HAVING COUNT(*) >= ${minWrites}
      ORDER BY application_name, COUNT(*) DESC
    `);

    // Step 3: Build service-to-tables mapping
    const serviceToTables: Record<string, Set<string>> = {};
    const tableToServices: Record<string, Set<string>> = {};

    for (const row of serviceWritesResult.rows) {
      const service = row.application_name;
      const table = row.full_table_name;

      if (!serviceToTables[service]) {
        serviceToTables[service] = new Set();
      }
      serviceToTables[service].add(table);

      if (!tableToServices[table]) {
        tableToServices[table] = new Set();
      }
      tableToServices[table].add(service);
    }

    // Step 4: Assign tables to services
    const serviceGroups: ServiceGroup[] = [];
    const assignedTables = new Set<string>();

    // First pass: tables owned by a single service
    for (const [service, tables] of Object.entries(serviceToTables)) {
      const serviceTables = Array.from(tables).filter(table => {
        // Only assign if this service is the PRIMARY writer (or only writer)
        const services = tableToServices[table];
        return services && services.size === 1;
      });

      if (serviceTables.length > 0) {
        // Calculate total size for this service's tables
        let totalSizeBytes = 0;
        serviceTables.forEach(table => {
          const tableInfo = allTablesResult.rows.find(r => r.full_table_name === table);
          if (tableInfo) {
            totalSizeBytes += parseInt(tableInfo.size_bytes || '0');
            assignedTables.add(table);
          }
        });

        serviceGroups.push({
          serviceName: service,
          tables: serviceTables.sort(),
          totalSize: formatBytes(totalSizeBytes),
          sizeBytes: totalSizeBytes,
        });
      }
    }

    // Second pass: tables written by multiple services (assign to most frequent writer)
    const sharedTables = allTablesResult.rows
      .map(r => r.full_table_name)
      .filter(table => {
        const services = tableToServices[table];
        return services && services.size > 1 && !assignedTables.has(table);
      });

    if (sharedTables.length > 0) {
      // Create a "Shared" service group
      let totalSizeBytes = 0;
      sharedTables.forEach(table => {
        const tableInfo = allTablesResult.rows.find(r => r.full_table_name === table);
        if (tableInfo) {
          totalSizeBytes += parseInt(tableInfo.size_bytes || '0');
          assignedTables.add(table);
        }
      });

      serviceGroups.push({
        serviceName: 'shared-tables',
        tables: sharedTables.sort(),
        totalSize: formatBytes(totalSizeBytes),
        sizeBytes: totalSizeBytes,
      });
    }

    // Step 5: Ungrouped tables (no recent writes from any service)
    const ungroupedTables = allTablesResult.rows
      .filter(r => !assignedTables.has(r.full_table_name))
      .map(r => r.full_table_name);

    const ungroupedSizeBytes = allTablesResult.rows
      .filter(r => !assignedTables.has(r.full_table_name))
      .reduce((sum, r) => sum + parseInt(r.size_bytes || '0'), 0);

    const ungrouped: UngroupedTables = {
      tables: ungroupedTables.sort(),
      totalSize: formatBytes(ungroupedSizeBytes),
      sizeBytes: ungroupedSizeBytes,
    };

    // Step 6: Get table sizes for reference
    const tableSizes: Record<string, { sizeBytes: number; sizeHuman: string }> = {};
    for (const row of allTablesResult.rows) {
      tableSizes[row.full_table_name] = {
        sizeBytes: parseInt(row.size_bytes || '0'),
        sizeHuman: row.size_human,
      };
    }

    res.status(200).json({
      serviceGroups: serviceGroups.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0)),
      ungrouped,
      tableSizes,
      summary: {
        totalTables: allTablesResult.rows.length,
        assignedTables: assignedTables.size,
        ungroupedTables: ungroupedTables.length,
        serviceCount: serviceGroups.length,
      },
    });
  } catch (error: any) {
    console.error('Error getting service groups:', error);
    res.status(500).json({ error: 'Failed to get service groups', details: error.message });
  } finally {
    await sourcePool.end();
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
