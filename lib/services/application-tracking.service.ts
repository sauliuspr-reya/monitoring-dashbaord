import { Pool } from 'pg';

export interface ApplicationWriteStats {
  applicationName: string;
  table: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  count: number;
  lastWriteTime?: Date;
  username?: string;
  clientAddr?: string;
}

export class ApplicationTrackingService {
  /**
   * CLI tools to exclude from service tracking
   */
  private readonly CLI_TOOLS = [
    'psql',
    'pg_dump',
    'pg_restore',
    'postgres client',
    'dbeaver',
    'pgadmin',
    'unknown',
  ];

  /**
   * Check if an application name should be excluded (CLI tools)
   */
  private shouldExcludeApplication(appName: string | null | undefined): boolean {
    if (!appName) return true;
    const lower = appName.toLowerCase();
    return this.CLI_TOOLS.some(tool => lower.includes(tool.toLowerCase()));
  }

  /**
   * Get which services (application_name) are writing to which tables
   * Uses pg_stat_activity for real-time data and pg_stat_statements for historical data
   * @param targetPool Database pool to query
   * @param hours Time window in hours for historical data (default: 2)
   */
  async getWriteStatsByApplication(
    targetPool: Pool,
    hours: number = 24
  ): Promise<ApplicationWriteStats[]> {
    try {
      // Step 1: Get all services with application_name (fast, simple query)
      const allConnections = await this.getAllActiveConnections(targetPool);
      
      // Step 2: Get write activity summary by application_name (efficient query)
      const writeActivitySummary = await this.getWriteActivitySummary(targetPool);
      
      // Step 3: Get historical stats from pg_stat_statements if available (optional, for counts)
      // This is important for services that may not be currently connected
      let historicalStats: ApplicationWriteStats[] = [];
      const hasPgStatStatements = await this.checkExtension(targetPool, 'pg_stat_statements');
      if (hasPgStatStatements) {
        historicalStats = await this.getHistoricalWriteCounts(targetPool, hours);
      }

      // Step 4: Also get services from pg_stat_statements that might not be in pg_stat_activity
      // This helps capture services like fast-indexer that might not be actively connected right now
      const historicalServices = new Set<string>();
      if (hasPgStatStatements && historicalStats.length > 0) {
        // Extract unique application names from historical stats
        // Note: historical stats might have 'unknown-service', we'll handle that
        for (const stat of historicalStats) {
          if (stat.applicationName && stat.applicationName !== 'unknown-service') {
            historicalServices.add(stat.applicationName);
          }
        }
      }

      // Step 5: Merge all data - start with connections, enrich with write activity
      const statsMap = new Map<string, ApplicationWriteStats>();
      
      // For each connection, create an entry
      for (const conn of allConnections) {
        if (this.shouldExcludeApplication(conn.applicationName)) {
          continue;
        }
        
        // Get write activity for this service
        const activity = writeActivitySummary.get(conn.applicationName);
        const historical = historicalStats.filter(s => s.applicationName === conn.applicationName);
        
        if (activity && activity.length > 0) {
          // Service has write activity - use the activity data
          for (const act of activity) {
            const key = `${conn.applicationName}:${act.table}:${act.operation}`;
            // Merge with historical count if available
            const histCount = historical.find(h => h.table === act.table && h.operation === act.operation)?.count || 0;
            statsMap.set(key, {
              ...act,
              count: Math.max(act.count, histCount),
              username: conn.username || act.username,
              clientAddr: conn.clientAddr || act.clientAddr,
            });
          }
        } else if (historical.length > 0) {
          // No current activity but has historical data
          for (const hist of historical) {
            const key = `${conn.applicationName}:${hist.table}:${hist.operation}`;
            statsMap.set(key, {
              ...hist,
              applicationName: conn.applicationName, // Override with actual connection name
              username: conn.username || hist.username,
              clientAddr: conn.clientAddr || hist.clientAddr,
            });
          }
        } else {
          // No write activity - create placeholder so service shows up
          const key = `${conn.applicationName}:<no-recent-writes>:INSERT`;
          statsMap.set(key, {
            applicationName: conn.applicationName,
            table: '<no-recent-writes>',
            operation: 'INSERT',
            count: 0,
            username: conn.username,
            clientAddr: conn.clientAddr,
          });
        }
      }

      // Step 6: Also include services from historical stats that aren't in current connections
      // This ensures we capture services like fast-indexer that have written recently but aren't connected now
      for (const serviceName of historicalServices) {
        if (this.shouldExcludeApplication(serviceName)) {
          continue;
        }
        
        // Check if we already have this service from connections
        const alreadyIncluded = Array.from(statsMap.keys()).some(key => key.startsWith(`${serviceName}:`));
        if (alreadyIncluded) {
          continue; // Already processed above
        }
        
        // Get historical stats for this service
        const historical = historicalStats.filter(s => s.applicationName === serviceName);
        if (historical.length > 0) {
          for (const hist of historical) {
            const key = `${serviceName}:${hist.table}:${hist.operation}`;
            // Only add if we don't already have it
            if (!statsMap.has(key)) {
              statsMap.set(key, {
                ...hist,
                applicationName: serviceName,
              });
            }
          }
        }
      }

      const allStats = Array.from(statsMap.values());
      return allStats;
    } catch (error) {
      console.error('Error getting write stats:', error);
      return [];
    }
  }

  /**
   * Get all active connections with application_name (even if not writing)
   * This helps show services that are connected but not currently writing
   */
  private async getAllActiveConnections(
    targetPool: Pool
  ): Promise<Array<{ applicationName: string; username?: string; clientAddr?: string }>> {
    try {
      // Get all connections with application_name
      // Include both active and recently idle connections (within last hour)
      const result = await targetPool.query(`
        SELECT DISTINCT
          application_name,
          usename,
          client_addr
        FROM pg_stat_activity
        WHERE application_name IS NOT NULL
          AND application_name != ''
          AND application_name NOT ILIKE '%psql%'
          AND application_name NOT ILIKE '%pg_dump%'
          AND application_name NOT ILIKE '%pg_restore%'
          AND application_name NOT ILIKE '%dbeaver%'
          AND application_name NOT ILIKE '%pgadmin%'
          AND application_name NOT ILIKE '%unknown%'
          AND datname = current_database()
          AND pid != pg_backend_pid()
          AND (
            state = 'active'
            OR state = 'idle'
            OR state = 'idle in transaction'
            OR (state_change > NOW() - INTERVAL '24 hours')
          )
        ORDER BY application_name
      `);

      const connections = result.rows.map(row => ({
        applicationName: row.application_name,
        username: row.usename || undefined,
        clientAddr: row.client_addr || undefined,
      }));
      
      // Debug: Log all found application names for troubleshooting
      console.log(`[application-tracking] Found ${connections.length} connections:`, 
        connections.map(c => c.applicationName).join(', '));
      
      return connections;
    } catch (error) {
      console.error('[application-tracking] Error getting active connections:', error);
      console.error('[application-tracking] Error details:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  /**
   * Get write activity summary by application_name (efficient query)
   * Focuses on application_name first, then extracts table info
   */
  private async getWriteActivitySummary(
    targetPool: Pool
  ): Promise<Map<string, ApplicationWriteStats[]>> {
    try {
      // Simple, efficient query: get write queries grouped by application_name
      const result = await targetPool.query(`
        SELECT 
          application_name,
          usename,
          client_addr,
          query,
          query_start,
          state_change,
          state
        FROM pg_stat_activity
        WHERE application_name IS NOT NULL
          AND application_name != ''
          AND application_name NOT ILIKE '%psql%'
          AND application_name NOT ILIKE '%pg_dump%'
          AND application_name NOT ILIKE '%pg_restore%'
          AND application_name NOT ILIKE '%dbeaver%'
          AND application_name NOT ILIKE '%pgadmin%'
          AND application_name NOT ILIKE '%unknown%'
          AND query IS NOT NULL
          AND query != ''
          AND query NOT LIKE '%pg_stat%'
          AND query NOT LIKE '%pg_catalog%'
          AND (
            TRIM(query) ILIKE 'INSERT%'
            OR TRIM(query) ILIKE 'UPDATE%'
            OR TRIM(query) ILIKE 'DELETE%'
          )
          AND (
            state = 'active'
            OR (state = 'idle' AND state_change > NOW() - INTERVAL '24 hours')
            OR (state = 'idle in transaction' AND state_change > NOW() - INTERVAL '24 hours')
          )
        ORDER BY query_start DESC NULLS LAST
        LIMIT 500
      `);
      
      const activityMap = new Map<string, ApplicationWriteStats[]>();
      
      for (const row of result.rows) {
        const appName = row.application_name;
        if (this.shouldExcludeApplication(appName)) continue;
        
        // Extract table and operation (simplified - just get first table)
        const tables = this.extractTablesFromQuery(row.query);
        const operations = this.extractOperationsFromQuery(row.query);
        
        if (!activityMap.has(appName)) {
          activityMap.set(appName, []);
        }
        
        for (const table of tables.slice(0, 1)) { // Just first table to keep it simple
          for (const op of operations as ('INSERT' | 'UPDATE' | 'DELETE')[]) {
            const existing = activityMap.get(appName)!.find(s => s.table === table && s.operation === op);
            if (existing) {
              existing.count++;
              if (row.query_start && (!existing.lastWriteTime || new Date(row.query_start) > existing.lastWriteTime)) {
                existing.lastWriteTime = new Date(row.query_start);
              }
            } else {
              activityMap.get(appName)!.push({
                applicationName: appName,
                table,
                operation: op,
                count: 1,
                lastWriteTime: row.query_start ? new Date(row.query_start) : undefined,
                username: row.usename || undefined,
                clientAddr: row.client_addr || undefined,
              });
            }
          }
        }
      }
      
      return activityMap;
    } catch (error) {
      console.error('Error getting write activity summary:', error);
      return new Map();
    }
  }

  /**
   * Get historical write counts from pg_stat_statements (optimized)
   * Uses userid/dbid matching and precise query patterns for better accuracy
   * @param targetPool Database pool to query
   * @param hours Time window in hours (default: 2)
   */
  private async getHistoricalWriteCounts(
    targetPool: Pool,
    hours: number = 2
  ): Promise<ApplicationWriteStats[]> {
    try {
      // Check if pg_stat_statements extension exists
      const hasExtension = await this.checkExtension(targetPool, 'pg_stat_statements');
      if (!hasExtension) {
        return [];
      }

      // Strategy 1: Use userid from pg_stat_statements to match with pg_stat_activity
      // This is more reliable than query pattern matching
      // Get a map of (userid, dbid) -> application_name from current activity
      const userAppMapResult = await targetPool.query(`
        SELECT DISTINCT
          psa.usename,
          psa.datid as dbid,
          psa.application_name,
          psa.client_addr
        FROM pg_stat_activity psa
        WHERE psa.application_name IS NOT NULL
          AND psa.application_name != ''
          AND psa.application_name NOT ILIKE '%psql%'
          AND psa.application_name NOT ILIKE '%pg_dump%'
          AND psa.application_name NOT ILIKE '%pg_restore%'
          AND psa.application_name NOT ILIKE '%dbeaver%'
          AND psa.application_name NOT ILIKE '%pgadmin%'
          AND psa.application_name NOT ILIKE '%unknown%'
          AND psa.datname = current_database()
          AND (
            psa.state = 'active'
            OR psa.state = 'idle'
            OR psa.state = 'idle in transaction'
            OR (psa.state_change > NOW() - INTERVAL '24 hours')
          )
      `);

      // Create maps: username -> application_name, and also query pattern -> application_name
      const usernameToApp = new Map<string, { appName: string; clientAddr?: string }>();
      const queryPatternToApp = new Map<string, { appName: string; username?: string; clientAddr?: string }>();
      
      for (const row of userAppMapResult.rows) {
        if (this.shouldExcludeApplication(row.application_name)) continue;
        
        // Map username to application_name (most reliable)
        usernameToApp.set(row.usename, {
          appName: row.application_name,
          clientAddr: row.client_addr || undefined,
        });
      }

      // Strategy 2: Also get query patterns from current activity for better matching
      const queryPatternResult = await targetPool.query(`
        SELECT DISTINCT
          application_name,
          usename,
          client_addr,
          query
        FROM pg_stat_activity
        WHERE application_name IS NOT NULL
          AND application_name != ''
          AND application_name NOT ILIKE '%psql%'
          AND application_name NOT ILIKE '%pg_dump%'
          AND application_name NOT ILIKE '%pg_restore%'
          AND application_name NOT ILIKE '%dbeaver%'
          AND application_name NOT ILIKE '%pgadmin%'
          AND application_name NOT ILIKE '%unknown%'
          AND query IS NOT NULL
          AND query != ''
          AND LENGTH(query) < 1000  -- Avoid very long queries
          AND (
            TRIM(query) ~* '^\\s*(INSERT|UPDATE|DELETE)'
          )
          AND (
            state = 'active'
            OR state = 'idle'
            OR state = 'idle in transaction'
            OR (state_change > NOW() - INTERVAL '24 hours')
          )
        LIMIT 500
      `);

      for (const row of queryPatternResult.rows) {
        if (this.shouldExcludeApplication(row.application_name)) continue;
        const normalized = this.normalizeQuery(row.query);
        if (normalized && normalized.length > 10) { // Only store meaningful patterns
          queryPatternToApp.set(normalized, {
            appName: row.application_name,
            username: row.usename || undefined,
            clientAddr: row.client_addr || undefined,
          });
        }
      }

      // Strategy 3: Query pg_stat_statements with precise filtering
      // Use regex for better pattern matching and filter by userid/dbid
      const currentDbId = await targetPool.query(`SELECT oid as dbid FROM pg_database WHERE datname = current_database()`);
      const dbid = currentDbId.rows[0]?.dbid;

      // Build query with parameterized dbid to prevent SQL injection
      const query = `
        WITH user_mapping AS (
          SELECT 
            u.usesysid as userid,
            u.usename
          FROM pg_user u
        )
        SELECT 
          pss.query,
          pss.calls,
          pss.userid,
          pss.dbid,
          um.usename,
          pss.mean_exec_time,
          pss.total_exec_time
        FROM pg_stat_statements pss
        LEFT JOIN user_mapping um ON pss.userid = um.userid
        WHERE (
          -- Precise regex patterns for write operations (anchored at start)
          pss.query ~* '^\\s*INSERT\\s+INTO'
          OR pss.query ~* '^\\s*UPDATE\\s+'
          OR pss.query ~* '^\\s*DELETE\\s+FROM'
        )
        AND pss.calls > 0
        ${dbid ? 'AND pss.dbid = $1' : ''}
        AND LENGTH(pss.query) < 5000  -- Avoid extremely long queries
        ORDER BY pss.calls DESC
        LIMIT 2000
      `;
      
      const result = await targetPool.query(query, dbid ? [dbid] : []);
      
      const stats: ApplicationWriteStats[] = [];
      const statsMap = new Map<string, ApplicationWriteStats>(); // Deduplicate by key
      
      for (const row of result.rows) {
        // Try to identify application_name using multiple strategies
        let appName: string | null = null;
        let username: string | undefined = row.usename || undefined;
        let clientAddr: string | undefined = undefined;

        // Strategy 1: Match by username (most reliable)
        if (username && usernameToApp.has(username)) {
          const appInfo = usernameToApp.get(username)!;
          appName = appInfo.appName;
          clientAddr = appInfo.clientAddr;
        }

        // Strategy 2: Match by query pattern (fallback)
        if (!appName) {
          const normalized = this.normalizeQuery(row.query);
          if (normalized && queryPatternToApp.has(normalized)) {
            const appInfo = queryPatternToApp.get(normalized)!;
            appName = appInfo.appName;
            username = appInfo.username || username;
            clientAddr = appInfo.clientAddr;
          }
        }

        // If we still can't identify, mark as unknown but still capture stats
        if (!appName || this.shouldExcludeApplication(appName)) {
          appName = 'unknown-service';
        }
        
        const tables = this.extractTablesFromQuery(row.query);
        const operations = this.extractOperationsFromQuery(row.query);
        
        // Create stats entries for each table/operation combination
        for (const table of tables.slice(0, 1)) { // Limit to first table to avoid fragmentation
          for (const op of operations as ('INSERT' | 'UPDATE' | 'DELETE')[]) {
            const key = `${appName}:${table}:${op}`;
            const existing = statsMap.get(key);
            
            if (existing) {
              // Aggregate counts for same app/table/operation
              existing.count += parseInt(row.calls, 10);
            } else {
              statsMap.set(key, {
                applicationName: appName,
                table,
                operation: op,
                count: parseInt(row.calls, 10),
                username,
                clientAddr,
              });
            }
          }
        }
      }
      
      return Array.from(statsMap.values());
    } catch (error) {
      console.error('Error getting historical write counts:', error);
      return [];
    }
  }

  /**
   * Get historical write stats from pg_stat_statements
   * Tries to match queries with application_name from pg_stat_activity
   * @param targetPool Database pool to query
   * @param hours Time window in hours (default: 2)
   * @deprecated Use getHistoricalWriteCounts instead for better performance
   */
  private async getHistoricalWriteStats(
    targetPool: Pool,
    hours: number = 2
  ): Promise<ApplicationWriteStats[]> {
    try {
      // First, get a map of query patterns to application_name from current and recent connections
      // Include both active and recently completed queries (within last 10 minutes)
      // Exclude CLI tools
      const activityResult = await targetPool.query(`
        SELECT DISTINCT
          application_name,
          usename,
          client_addr,
          query
        FROM pg_stat_activity
        WHERE application_name IS NOT NULL
          AND application_name != ''
          AND application_name NOT ILIKE '%psql%'
          AND application_name NOT ILIKE '%pg_dump%'
          AND application_name NOT ILIKE '%pg_restore%'
          AND application_name NOT ILIKE '%dbeaver%'
          AND application_name NOT ILIKE '%pgadmin%'
          AND application_name NOT ILIKE '%unknown%'
          AND query IS NOT NULL
          AND query != ''
          AND (
            query ILIKE 'INSERT%'
            OR query ILIKE 'UPDATE%'
            OR query ILIKE 'DELETE%'
          )
          AND (
            state = 'active'
            OR (state = 'idle' AND state_change > NOW() - INTERVAL '10 minutes')
          )
      `);

      // Create a map of normalized query patterns to application info
      const queryToApp = new Map<string, { appName: string; username?: string; clientAddr?: string }>();
      for (const row of activityResult.rows) {
        const normalized = this.normalizeQuery(row.query);
        if (normalized && row.application_name) {
          queryToApp.set(normalized, {
            appName: row.application_name,
            username: row.usename,
            clientAddr: row.client_addr,
          });
        }
      }

      // Calculate cutoff time for historical data
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - hours);

      // Now query pg_stat_statements
      // This captures ALL write queries, even if the application isn't currently active
      // We'll try to match them with application_name patterns from recent activity
      const result = await targetPool.query(`
        SELECT 
          query,
          calls,
          total_exec_time,
          mean_exec_time,
          max_exec_time
        FROM pg_stat_statements
        WHERE (
          query ILIKE 'INSERT INTO%'
          OR query ILIKE 'UPDATE%'
          OR query ILIKE 'DELETE FROM%'
        )
        AND calls > 0
        ORDER BY calls DESC
        LIMIT 2000
      `);

      const statsMap = new Map<string, ApplicationWriteStats>();

      for (const row of result.rows) {
        const normalized = this.normalizeQuery(row.query);
        const appInfo = normalized && queryToApp.has(normalized) 
          ? queryToApp.get(normalized)! 
          : null;

        // Extract tables first - we want to capture all writes even if we can't identify the app
        const tables = this.extractTablesFromQuery(row.query);
        const operations = this.extractOperationsFromQuery(row.query);

        // If we can't identify the application, try to infer from query patterns
        // or use a generic identifier, but still capture the write stats
        let appName = appInfo?.appName;
        if (!appName || this.shouldExcludeApplication(appName)) {
          // Try to infer from query characteristics
          // For now, we'll still include it but mark as 'unknown-service'
          // This ensures we don't lose write statistics
          appName = 'unknown-service';
        }

        for (const table of tables) {
          for (const op of operations as ('INSERT' | 'UPDATE' | 'DELETE')[]) {
            const key = `${appName}:${table}:${op}`;
            const existing = statsMap.get(key);

            if (existing) {
              existing.count += parseInt(row.calls, 10);
            } else {
              statsMap.set(key, {
                applicationName: appName,
                table,
                operation: op,
                count: parseInt(row.calls, 10),
                username: appInfo?.username,
                clientAddr: appInfo?.clientAddr,
              });
            }
          }
        }
      }

      // Filter out 'unknown-service' entries if we have better data
      // But keep them if they're the only data we have
      const filteredStats = Array.from(statsMap.values());
      
      // If we have known services, remove unknown-service entries
      const hasKnownServices = filteredStats.some(s => s.applicationName !== 'unknown-service');
      if (hasKnownServices) {
        return filteredStats.filter(s => s.applicationName !== 'unknown-service');
      }
      
      return filteredStats;
    } catch (error) {
      console.error('Error getting historical write stats:', error);
      return [];
    }
  }

  /**
   * Normalize a query to match patterns (remove values, normalize whitespace)
   */
  private normalizeQuery(query: string): string | null {
    if (!query) return null;
    
    // Remove comments
    let normalized = query.replace(/--.*$/gm, '');
    
    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();
    
    // Remove string literals (basic pattern)
    normalized = normalized.replace(/'[^']*'/g, "'?'");
    normalized = normalized.replace(/"([^"]*)"/g, '"$1"'); // Keep quoted identifiers
    
    // Remove numeric values (basic pattern)
    normalized = normalized.replace(/\b\d+\b/g, '?');
    
    return normalized.toUpperCase();
  }

  /**
   * Get current write activity from pg_stat_activity
   * This is the most reliable method as it directly shows application_name
   * Also includes recently completed queries (state = 'idle' with recent state_change)
   */
  private async getCurrentWriteActivity(
    targetPool: Pool
  ): Promise<ApplicationWriteStats[]> {
    // Get all active connections with application_name
    // Include both active queries and recently completed queries (within last 10 minutes)
    // This helps capture writes that just completed
    const result = await targetPool.query(`
      SELECT 
        application_name,
        usename,
        client_addr,
        query,
        query_start,
        state_change,
        state
      FROM pg_stat_activity
      WHERE application_name IS NOT NULL
        AND application_name != ''
        AND application_name NOT ILIKE '%psql%'
        AND application_name NOT ILIKE '%pg_dump%'
        AND application_name NOT ILIKE '%pg_restore%'
        AND application_name NOT ILIKE '%dbeaver%'
        AND application_name NOT ILIKE '%pgadmin%'
        AND application_name NOT ILIKE '%unknown%'
        AND query IS NOT NULL
        AND query != ''
        AND query NOT LIKE '%pg_stat%'
        AND query NOT LIKE '%pg_catalog%'
        AND (
          query ILIKE 'INSERT%'
          OR query ILIKE 'UPDATE%'
          OR query ILIKE 'DELETE%'
        )
        AND (
          state = 'active'
          OR (state = 'idle' AND state_change > NOW() - INTERVAL '10 minutes')
          OR (state = 'idle in transaction' AND state_change > NOW() - INTERVAL '10 minutes')
        )
      ORDER BY query_start DESC NULLS LAST
      LIMIT 2000;
    `);
    
    console.log(`[application-tracking] getCurrentWriteActivity found ${result.rows.length} active write queries`);

    const statsMap = new Map<string, ApplicationWriteStats>();

    for (const row of result.rows) {
      const tables = this.extractTablesFromQuery(row.query);
      const operations = this.extractOperationsFromQuery(row.query);
      const appName = row.application_name || 'unknown';
      const username = row.usename || undefined;
      const clientAddr = row.client_addr || undefined;

      for (const table of tables) {
        for (const op of operations as ('INSERT' | 'UPDATE' | 'DELETE')[]) {
          // Group by app, table, operation (not by username/IP to avoid fragmentation)
          const key = `${appName}:${table}:${op}`;
          const existing = statsMap.get(key);

          if (existing) {
            existing.count++;
            if (row.query_start && (!existing.lastWriteTime || new Date(row.query_start) > existing.lastWriteTime)) {
              existing.lastWriteTime = new Date(row.query_start);
            }
            // Collect unique usernames and IPs (store as comma-separated for now)
            // Frontend will handle displaying multiple values
            if (username && existing.username && !existing.username.includes(username)) {
              existing.username = `${existing.username}, ${username}`;
            } else if (username && !existing.username) {
              existing.username = username;
            }
            if (clientAddr && existing.clientAddr && !existing.clientAddr.includes(clientAddr)) {
              existing.clientAddr = `${existing.clientAddr}, ${clientAddr}`;
            } else if (clientAddr && !existing.clientAddr) {
              existing.clientAddr = clientAddr;
            }
          } else {
            statsMap.set(key, {
              applicationName: appName,
              table,
              operation: op,
              count: 1,
              lastWriteTime: row.query_start ? new Date(row.query_start) : undefined,
              username,
              clientAddr,
            });
          }
        }
      }
    }

    return Array.from(statsMap.values());
  }

  /**
   * Check if a PostgreSQL extension is available
   */
  private async checkExtension(pool: Pool, extensionName: string): Promise<boolean> {
    try {
      const result = await pool.query(`
        SELECT EXISTS(
          SELECT 1 FROM pg_extension WHERE extname = $1
        ) as exists;
      `, [extensionName]);
      return result.rows[0].exists;
    } catch {
      return false;
    }
  }

  /**
   * Extract table names from SQL query
   * Handles both quoted and unquoted identifiers, schema-qualified names
   * Filters out SQL keywords and schema names that aren't actual tables
   */
  private extractTablesFromQuery(query: string): string[] {
    const tables: string[] = [];
    if (!query) return tables;

    // SQL keywords and schema names that should NOT be treated as table names
    const excludedIdentifiers = new Set([
      'set', 'select', 'from', 'where', 'insert', 'into', 'update', 'delete',
      'public', 'information_schema', 'pg_catalog', 'pg_toast',
      'values', 'as', 'on', 'using', 'join', 'inner', 'outer', 'left', 'right',
      'union', 'except', 'intersect', 'order', 'group', 'by', 'having',
      'limit', 'offset', 'with', 'returning', 'default', 'null'
    ]);

    // Handle schema.table format and quoted identifiers
    // INSERT INTO "TableName" or INSERT INTO schema."TableName"
    // Also handle case-sensitive table names like "StorkPriceCandle"
    const insertPatterns = [
      /INSERT\s+INTO\s+(?:["']?(\w+)["']?\.)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/i,
      /INSERT\s+INTO\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?/i,
      // More flexible pattern for quoted identifiers with mixed case
      /INSERT\s+INTO\s+(?:["']?(\w+)["']?\.)?["']([^"]+)["']/i,
      /INSERT\s+INTO\s+["']([^"]+)["']/i,
    ];

    for (const pattern of insertPatterns) {
      const match = query.match(pattern);
      if (match) {
        // Try match[2] first (schema.table), then match[1] (table only)
        let tableName = (match[2] || match[1])?.trim();
        
        // If we matched schema.table format, extract just the table name
        if (tableName && tableName.includes('.')) {
          const parts = tableName.split('.');
          tableName = parts[parts.length - 1]; // Get the last part (table name)
        }
        
        // Filter out excluded identifiers and ensure it's a valid table name
        if (tableName && 
            !excludedIdentifiers.has(tableName.toLowerCase()) &&
            !tables.includes(tableName) &&
            tableName.length > 0) {
          tables.push(tableName);
        }
      }
    }

    // UPDATE "TableName" or UPDATE schema."TableName"
    // Also handle case-sensitive table names
    const updatePatterns = [
      /UPDATE\s+(?:["']?(\w+)["']?\.)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/i,
      /UPDATE\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?/i,
      // More flexible pattern for quoted identifiers with mixed case
      /UPDATE\s+(?:["']?(\w+)["']?\.)?["']([^"]+)["']/i,
      /UPDATE\s+["']([^"]+)["']/i,
    ];

    for (const pattern of updatePatterns) {
      const match = query.match(pattern);
      if (match) {
        let tableName = (match[2] || match[1])?.trim();
        
        // If we matched schema.table format, extract just the table name
        if (tableName && tableName.includes('.')) {
          const parts = tableName.split('.');
          tableName = parts[parts.length - 1]; // Get the last part (table name)
        }
        
        // Filter out excluded identifiers and ensure it's a valid table name
        if (tableName && 
            !excludedIdentifiers.has(tableName.toLowerCase()) &&
            !tables.includes(tableName) &&
            tableName.length > 0) {
          tables.push(tableName);
        }
      }
    }

    // DELETE FROM "TableName" or DELETE FROM schema."TableName"
    const deletePatterns = [
      /DELETE\s+FROM\s+(?:["']?(\w+)["']?\.)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/i,
      /DELETE\s+FROM\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?/i,
      // More flexible pattern for quoted identifiers with mixed case
      /DELETE\s+FROM\s+(?:["']?(\w+)["']?\.)?["']([^"]+)["']/i,
      /DELETE\s+FROM\s+["']([^"]+)["']/i,
    ];

    for (const pattern of deletePatterns) {
      const match = query.match(pattern);
      if (match) {
        let tableName = (match[2] || match[1])?.trim();
        
        // If we matched schema.table format, extract just the table name
        if (tableName && tableName.includes('.')) {
          const parts = tableName.split('.');
          tableName = parts[parts.length - 1]; // Get the last part (table name)
        }
        
        // Filter out excluded identifiers and ensure it's a valid table name
        if (tableName && 
            !excludedIdentifiers.has(tableName.toLowerCase()) &&
            !tables.includes(tableName) &&
            tableName.length > 0) {
          tables.push(tableName);
        }
      }
    }

    return tables;
  }

  /**
   * Extract operation types from SQL query
   */
  private extractOperationsFromQuery(query: string): ('INSERT' | 'UPDATE' | 'DELETE')[] {
    const operations: ('INSERT' | 'UPDATE' | 'DELETE')[] = [];
    if (!query) return operations;
    
    // Trim leading blanks and normalize
    const trimmedQuery = query.trim();
    const upperQuery = trimmedQuery.toUpperCase();

    // Match SQL operations at the start (after trimming)
    // Use word boundary to avoid matching inside other words
    if (/^\s*INSERT\s+/i.test(trimmedQuery)) {
      operations.push('INSERT');
    }
    if (/^\s*UPDATE\s+/i.test(trimmedQuery)) {
      operations.push('UPDATE');
    }
    if (/^\s*DELETE\s+/i.test(trimmedQuery)) {
      operations.push('DELETE');
    }

    return operations;
  }
}

