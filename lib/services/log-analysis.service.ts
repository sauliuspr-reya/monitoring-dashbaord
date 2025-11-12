import { Pool } from 'pg';
import { ConflictDetection } from '../types';

export interface LogConflict {
  tableName: string;
  primaryKey: string;
  keyValue: string;
  errorMessage: string;
  timestamp: Date;
  applicationName?: string;
}

export class LogAnalysisService {
  /**
   * Query Cloud SQL logs for primary key conflicts
   * This queries pg_stat_statements and error logs
   */
  async detectConflictsFromLogs(
    targetPool: Pool,
    timeRange: { start: Date; end: Date } = {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      end: new Date(),
    }
  ): Promise<LogConflict[]> {
    const conflicts: LogConflict[] = [];

    try {
      // Check if pg_stat_statements extension is available
      const extCheck = await targetPool.query(`
        SELECT EXISTS(
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
        ) as exists;
      `);

      if (!extCheck.rows[0].exists) {
        console.warn('pg_stat_statements extension not available');
        return conflicts;
      }

      // Query for duplicate key errors in pg_stat_statements
      // Note: This requires pg_stat_statements to be configured to log errors
      const result = await targetPool.query(`
        SELECT 
          query,
          calls,
          mean_exec_time
        FROM pg_stat_statements
        WHERE query LIKE '%duplicate key%'
          OR query LIKE '%violates unique constraint%'
          OR query LIKE '%primary key%'
        ORDER BY calls DESC
        LIMIT 100;
      `);

      // Parse the queries to extract table and key information
      for (const row of result.rows) {
        const conflict = this.parseConflictFromQuery(row.query);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    } catch (error) {
      console.error('Error detecting conflicts from logs:', error);
    }

    return conflicts;
  }

  /**
   * Query pg_stat_activity to see which services are writing to which tables
   */
  async getWriteActivityByService(
    targetPool: Pool
  ): Promise<Map<string, { table: string; operation: string; count: number }[]>> {
    const activity = new Map<string, { table: string; operation: string; count: number }[]>();

    try {
      // Query active connections and their queries
      const result = await targetPool.query(`
        SELECT 
          application_name,
          state,
          query,
          query_start,
          state_change
        FROM pg_stat_activity
        WHERE state = 'active'
          AND query NOT LIKE '%pg_stat_activity%'
          AND application_name IS NOT NULL
          AND application_name != ''
        ORDER BY query_start DESC;
      `);

      for (const row of result.rows) {
        const appName = row.application_name || 'unknown';
        const tables = this.extractTablesFromQuery(row.query);
        const operations = this.extractOperationsFromQuery(row.query);

        if (!activity.has(appName)) {
          activity.set(appName, []);
        }

        for (const table of tables) {
          for (const op of operations) {
            const existing = activity.get(appName)!.find(
              (a) => a.table === table && a.operation === op
            );
            if (existing) {
              existing.count++;
            } else {
              activity.get(appName)!.push({ table, operation: op, count: 1 });
            }
          }
        }
      }
    } catch (error) {
      console.error('Error getting write activity:', error);
    }

    return activity;
  }

  /**
   * Query pg_stat_statements to see which services write to which tables
   * This provides historical data, not just current activity
   */
  async getHistoricalWriteStats(
    targetPool: Pool,
    timeRange: { start: Date; end: Date }
  ): Promise<Map<string, { table: string; operation: string; calls: number; totalTime: number }[]>> {
    const stats = new Map<string, { table: string; operation: string; calls: number; totalTime: number }[]>();

    try {
      // Check if pg_stat_statements is available
      const extCheck = await targetPool.query(`
        SELECT EXISTS(
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
        ) as exists;
      `);

      if (!extCheck.rows[0].exists) {
        return stats;
      }

      // Query pg_stat_statements for INSERT/UPDATE/DELETE operations
      // Note: We can't reliably join with pg_stat_activity as queries change over time
      const result = await targetPool.query(`
        SELECT 
          query,
          calls,
          total_exec_time
        FROM pg_stat_statements
        WHERE (
          query ILIKE 'INSERT%'
          OR query ILIKE 'UPDATE%'
          OR query ILIKE 'DELETE%'
        )
        ORDER BY calls DESC
        LIMIT 500;
      `);

      for (const row of result.rows) {
        // Since we can't get app name from pg_stat_statements, use 'all_applications'
        const appName = 'all_applications';
        const tables = this.extractTablesFromQuery(row.query);
        const operations = this.extractOperationsFromQuery(row.query);

        if (!stats.has(appName)) {
          stats.set(appName, []);
        }

        for (const table of tables) {
          for (const op of operations) {
            const existing = stats.get(appName)!.find(
              (s) => s.table === table && s.operation === op
            );
            if (existing) {
              existing.calls += parseInt(row.calls, 10);
              existing.totalTime += parseFloat(row.total_exec_time);
            } else {
              stats.get(appName)!.push({
                table,
                operation: op,
                calls: parseInt(row.calls, 10),
                totalTime: parseFloat(row.total_exec_time),
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('Error getting historical write stats:', error);
    }

    return stats;
  }

  /**
   * Parse conflict information from error query
   */
  private parseConflictFromQuery(
    query: string,
    applicationName?: string
  ): LogConflict | null {
    // Pattern: duplicate key value violates unique constraint "table_pkey"
    const duplicateKeyMatch = query.match(
      /duplicate key value violates unique constraint "([^"]+)"/
    );
    if (!duplicateKeyMatch) {
      return null;
    }

    const constraintName = duplicateKeyMatch[1];
    
    // Extract table name from constraint (usually table_pkey or table_column_key)
    const tableMatch = constraintName.match(/^([^_]+)/);
    const tableName = tableMatch ? tableMatch[1] : 'unknown';

    // Try to extract key value from query
    const keyValueMatch = query.match(/Key \(([^)]+)\)=\(([^)]+)\)/);
    const primaryKey = keyValueMatch ? keyValueMatch[1] : 'unknown';
    const keyValue = keyValueMatch ? keyValueMatch[2] : 'unknown';

    return {
      tableName,
      primaryKey,
      keyValue,
      errorMessage: query.substring(0, 200), // First 200 chars
      timestamp: new Date(),
      applicationName,
    };
  }

  /**
   * Extract table names from SQL query
   */
  private extractTablesFromQuery(query: string): string[] {
    const tables: string[] = [];
    
    // Match INSERT INTO table, UPDATE table, DELETE FROM table
    const patterns = [
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gi,
      /FROM\s+["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(query)) !== null) {
        const table = match[1];
        if (table && !tables.includes(table)) {
          tables.push(table);
        }
      }
    }

    return tables;
  }

  /**
   * Extract operation types from SQL query
   */
  private extractOperationsFromQuery(query: string): string[] {
    const operations: string[] = [];
    const upperQuery = query.toUpperCase().trim();

    if (upperQuery.startsWith('INSERT')) {
      operations.push('INSERT');
    } else if (upperQuery.startsWith('UPDATE')) {
      operations.push('UPDATE');
    } else if (upperQuery.startsWith('DELETE')) {
      operations.push('DELETE');
    }

    return operations;
  }
}

