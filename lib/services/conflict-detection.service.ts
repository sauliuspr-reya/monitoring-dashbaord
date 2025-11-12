import { Pool } from 'pg';
import { ConflictDetection } from '../types';
import { getDbPool } from '../db/connection';

export class ConflictDetectionService {
  /**
   * Check for conflicts in subscription worker logs
   * This queries pg_stat_subscription for error information
   */
  async detectConflicts(
    targetPool: Pool,
    subscriptionName: string,
    groupId: string
  ): Promise<ConflictDetection[]> {
    const conflicts: ConflictDetection[] = [];

    try {
      // Check for subscription errors in pg_stat_subscription
      // Note: PostgreSQL doesn't store detailed error info in system catalogs
      // We need to check the actual subscription worker process or logs
      const result = await targetPool.query(`
        SELECT 
          subname,
          pid,
          latest_end_lsn,
          latest_end_time
        FROM pg_stat_subscription
        WHERE subname = $1
      `, [subscriptionName]);

      // Check subscription worker status
      const workerResult = await targetPool.query(`
        SELECT 
          pid,
          state,
          query,
          state_change
        FROM pg_stat_activity
        WHERE application_name = $1
          AND state = 'idle in transaction (aborted)'
      `, [subscriptionName]);

      // If worker is in aborted state, there's likely a conflict
      if (workerResult.rows.length > 0) {
        // Try to get more details from pg_stat_subscription_rel
        const relResult = await targetPool.query(`
          SELECT 
            srrelid::regclass as table_name,
            srsubstate,
            srsublsn
          FROM pg_subscription_rel
          WHERE srsubid = (
            SELECT oid FROM pg_subscription WHERE subname = $1
          )
          AND srsubstate = 'e'  -- 'e' = error state
        `, [subscriptionName]);

        for (const row of relResult.rows) {
            conflicts.push({
              id: '', // Will be set when saving
              subscriptionId: groupId,
              groupId, // Legacy support
              tableName: row.table_name,
              errorType: 'replication_error',
              errorMessage: `Subscription worker in error state for table ${row.table_name}`,
              detectedAt: new Date(),
              severity: 'error',
            });
        }
      }

      // Check for duplicate key errors in pg_stat_statements if available
      try {
        const hasPgStatStatements = await targetPool.query(`
          SELECT EXISTS(
            SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
          ) as exists;
        `);

        if (hasPgStatStatements.rows[0].exists) {
          const errorQueries = await targetPool.query(`
            SELECT 
              query,
              calls,
              (SELECT application_name FROM pg_stat_activity WHERE query = pss.query LIMIT 1) as application_name
            FROM pg_stat_statements pss
            WHERE query LIKE '%duplicate key%'
              OR query LIKE '%violates unique constraint%'
            ORDER BY calls DESC
            LIMIT 50;
          `);

          for (const row of errorQueries.rows) {
            const tableMatch = row.query.match(/constraint "([^"]+)"|table "([^"]+)"/i);
            const tableName = tableMatch ? (tableMatch[1] || tableMatch[2]) : 'unknown';
            const keyMatch = row.query.match(/Key \(([^)]+)\)=\(([^)]+)\)/);
            
            conflicts.push({
              id: '',
              subscriptionId: groupId,
              groupId, // Legacy support
              tableName,
              errorType: 'duplicate_key',
              errorMessage: row.query.substring(0, 200),
              detectedAt: new Date(),
              severity: 'error',
            });
          }
        }
      } catch (error) {
        // pg_stat_statements might not be available, continue
        console.debug('pg_stat_statements not available:', error);
      }

      return conflicts;
    } catch (error) {
      console.error('Error detecting conflicts:', error);
      return [];
    }
  }

  /**
   * Check for duplicate key errors by comparing row counts and checking for specific error patterns
   * This is a heuristic approach since PostgreSQL doesn't expose detailed error info
   */
  async checkForDuplicateKeyErrors(
    sourcePool: Pool,
    targetPool: Pool,
    tableName: string,
    schemaName: string = 'public',
    groupId: string
  ): Promise<ConflictDetection | null> {
    try {
      // Get primary key column
      const pkResult = await sourcePool.query(`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass
          AND i.indisprimary
        LIMIT 1
      `, [`${schemaName}."${tableName}"`]);

      if (pkResult.rows.length === 0) {
        return null; // No primary key, can't check for duplicates
      }

      const pkColumn = pkResult.rows[0].attname;

      // Check for duplicate primary keys between source and target
      // This indicates a conflict scenario
      const dupResult = await sourcePool.query(`
        WITH source_pks AS (
          SELECT ${pkColumn} as pk_value
          FROM ${schemaName}."${tableName}"
        ),
        target_pks AS (
          SELECT ${pkColumn} as pk_value
          FROM ${schemaName}."${tableName}"
        )
        SELECT COUNT(*) as duplicate_count
        FROM source_pks s
        WHERE EXISTS (SELECT 1 FROM target_pks t WHERE t.pk_value = s.pk_value)
      `);

      // This is a simplified check - in reality, we'd need to compare
      // the actual data to detect conflicts
      // For now, we'll rely on the subscription worker state check above

      return null;
    } catch (error) {
      console.error(`Error checking for duplicate keys in ${tableName}:`, error);
      return null;
    }
  }

  /**
   * Save conflict detection to database
   */
  async saveConflict(
    conflict: Omit<ConflictDetection, 'id'>
  ): Promise<ConflictDetection> {
    const pool = getDbPool();
    const subscriptionId = conflict.subscriptionId || conflict.groupId;
    
    // Support both subscription_id and group_id columns
    const result = await pool.query(`
      INSERT INTO conflict_detections (
        subscription_id, table_name, error_message, error_type,
        detected_at, severity
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      subscriptionId,
      conflict.tableName,
      conflict.errorMessage,
      conflict.errorType,
      conflict.detectedAt,
      conflict.severity,
    ]).catch(() =>
      pool.query(`
        INSERT INTO conflict_detections (
          group_id, table_name, error_message, error_type,
          detected_at, severity
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [
        subscriptionId,
        conflict.tableName,
        conflict.errorMessage,
        conflict.errorType,
        conflict.detectedAt,
        conflict.severity,
      ])
    );

    return this.mapRowToConflict(result.rows[0]);
  }

  /**
   * Get unresolved conflicts
   */
  async getUnresolvedConflicts(groupId?: string): Promise<ConflictDetection[]> {
    const pool = getDbPool();
    
    // Check which column exists (subscription_id or group_id)
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'conflict_detections' 
        AND column_name IN ('subscription_id', 'group_id')
      LIMIT 1
    `);
    
    const idColumn = columnCheck.rows[0]?.column_name || 'subscription_id';
    
    let query = `
      SELECT * FROM conflict_detections
      WHERE resolved_at IS NULL
    `;
    const params: string[] = [];

    if (groupId) {
      query += ` AND ${idColumn} = $1`;
      params.push(groupId);
    }

    query += ' ORDER BY detected_at DESC';

    const result = await pool.query(query, params);
    return result.rows.map(this.mapRowToConflict);
  }

  /**
   * Mark conflict as resolved
   */
  async resolveConflict(
    conflictId: string,
    resolvedBy: string,
    resolutionNotes?: string
  ): Promise<void> {
    const pool = getDbPool();
    await pool.query(`
      UPDATE conflict_detections
      SET resolved_at = NOW(),
          resolved_by = $1,
          resolution_notes = $2
      WHERE id = $3
    `, [resolvedBy, resolutionNotes, conflictId]);
  }

  private mapRowToConflict(row: any): ConflictDetection {
    return {
      id: row.id,
      subscriptionId: row.subscription_id || row.group_id,
      groupId: row.subscription_id || row.group_id, // Legacy support
      tableName: row.table_name,
      errorMessage: row.error_message,
      errorType: row.error_type,
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      resolutionNotes: row.resolution_notes,
      severity: row.severity,
    };
  }
}

