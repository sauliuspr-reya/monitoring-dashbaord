import { Pool } from 'pg';
import { getDbPool, createSourceTargetPool } from '../db/connection';
import {
  VerificationJob,
  VerificationMismatch,
  VerificationGap,
  RowWithHash,
  VerificationConfig,
} from '../types/verification.types';

export class VerificationService {
  private monitoringPool: Pool;

  constructor() {
    this.monitoringPool = getDbPool();
  }

  /**
   * Build composite key expression for SQL queries
   * For single column: returns "column_name"
   * For composite: returns "(col1::text || '::' || col2::text)"
   */
  private buildPkExpression(pkColumns: string[]): string {
    if (pkColumns.length === 1) {
      return pkColumns[0];
    }
    return `(${pkColumns.map(col => `${col}::text`).join(` || '::' || `)})`;
  }

  /**
   * Auto-detect primary key columns and their data types for a table
   * Supports both single and composite primary keys
   * Uses PostgreSQL system catalogs for accurate detection
   */
  async detectPrimaryKey(pool: Pool, tableName: string): Promise<{ columns: string[]; dataTypes: string[] }> {
    const [schema, table] = tableName.includes('.') 
      ? tableName.split('.') 
      : ['public', tableName];

    const query = `
      SELECT 
        a.attname as column_name,
        format_type(a.atttypid, a.atttypmod) as data_type,
        array_position(i.indkey, a.attnum) as key_position
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)
    `;

    const fullTableName = schema === 'public' ? table : `${schema}.${table}`;
    const result = await pool.query(query, [fullTableName]);

    if (result.rows.length === 0) {
      throw new Error(`No primary key found for table: ${tableName}`);
    }

    return {
      columns: result.rows.map((r: any) => r.column_name),
      dataTypes: result.rows.map((r: any) => r.data_type)
    };
  }

  /**
   * Start a new verification job or resume an existing one
   */
  async startVerification(config: VerificationConfig): Promise<VerificationJob> {
    const { tableName, batchSize, cooldownMs, primaryKeyColumn, primaryKeyColumns, startFromPkValue } = config;

    // Check if job already exists
    const existingJob = await this.getJobByTableName(tableName);

    if (existingJob) {
      // Resume existing job if stopped or errored (with updated config)
      if (existingJob.status === 'stopped' || existingJob.status === 'error') {
        // If startFromPkValue is provided, update the last_checked_pk_value
        const updateQuery = startFromPkValue
          ? `UPDATE table_verification_jobs 
             SET status = 'running', 
                 batch_size = $1, 
                 cooldown_ms = $2,
                 last_checked_pk_value = $4,
                 updated_at = NOW()
             WHERE id = $3`
          : `UPDATE table_verification_jobs 
             SET status = 'running', 
                 batch_size = $1, 
                 cooldown_ms = $2, 
                 updated_at = NOW()
             WHERE id = $3`;
        
        const params = startFromPkValue
          ? [batchSize, cooldownMs, existingJob.id, startFromPkValue]
          : [batchSize, cooldownMs, existingJob.id];
        
        await this.monitoringPool.query(updateQuery, params);
        
        return { 
          ...existingJob, 
          status: 'running',
          batch_size: batchSize,
          cooldown_ms: cooldownMs,
          last_checked_pk_value: startFromPkValue || existingJob.last_checked_pk_value,
        };
      }

      // If already running, return existing job
      if (existingJob.status === 'running') {
        return existingJob;
      }

      // If completed, ask user to confirm restart (handled by API layer)
      return existingJob;
    }

    // Create new job - use provided PK or auto-detect
    let pkColumns: string[];

    if (primaryKeyColumns && primaryKeyColumns.length > 0) {
      // Use provided primary key columns
      pkColumns = primaryKeyColumns;
    } else if (primaryKeyColumn) {
      // Use single provided column (convert to array)
      pkColumns = [primaryKeyColumn];
    } else {
      // Auto-detect primary key from source database
      const sourceUrl = process.env.SOURCE_DATABASE_URL;
      if (!sourceUrl) {
        throw new Error('SOURCE_DATABASE_URL not configured');
      }

      const sourcePool = createSourceTargetPool(sourceUrl);
      let pkInfo: { columns: string[]; dataTypes: string[] };

      try {
        pkInfo = await this.detectPrimaryKey(sourcePool, tableName);
        pkColumns = pkInfo.columns;
      } finally {
        await sourcePool.end();
      }
    }

    // Create new job with optional starting PK value
    const insertQuery = startFromPkValue
      ? `INSERT INTO table_verification_jobs 
         (table_name, status, batch_size, cooldown_ms, primary_key_columns, start_from_pk_value, last_checked_pk_value)
         VALUES ($1, 'running', $2, $3, $4, $5, $5)
         RETURNING *`
      : `INSERT INTO table_verification_jobs 
         (table_name, status, batch_size, cooldown_ms, primary_key_columns)
         VALUES ($1, 'running', $2, $3, $4)
         RETURNING *`;
    
    const params = startFromPkValue
      ? [tableName, batchSize, cooldownMs, pkColumns, startFromPkValue]
      : [tableName, batchSize, cooldownMs, pkColumns];

    const result = await this.monitoringPool.query(insertQuery, params);

    return result.rows[0];
  }

  /**
   * Stop a running verification job
   */
  async stopVerification(tableName: string): Promise<void> {
    await this.monitoringPool.query(
      `UPDATE table_verification_jobs 
       SET status = 'stopped', updated_at = NOW()
       WHERE table_name = $1 AND status = 'running'`,
      [tableName]
    );
  }

  /**
   * Get verification job by table name
   */
  async getJobByTableName(tableName: string): Promise<VerificationJob | null> {
    const result = await this.monitoringPool.query(
      'SELECT * FROM table_verification_jobs WHERE table_name = $1',
      [tableName]
    );
    return result.rows[0] || null;
  }

  /**
   * Get verification job by ID
   */
  async getJobById(jobId: number): Promise<VerificationJob | null> {
    const result = await this.monitoringPool.query(
      'SELECT * FROM table_verification_jobs WHERE id = $1',
      [jobId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all verification jobs
   */
  async getAllJobs(): Promise<VerificationJob[]> {
    const result = await this.monitoringPool.query(
      'SELECT * FROM table_verification_jobs ORDER BY updated_at DESC'
    );
    return result.rows;
  }

  /**
   * Get currently running job (only one can run at a time)
   */
  async getRunningJob(): Promise<VerificationJob | null> {
    const result = await this.monitoringPool.query(
      "SELECT * FROM table_verification_jobs WHERE status = 'running' LIMIT 1"
    );
    return result.rows[0] || null;
  }

  /**
   * Fetch batch of rows from source database with hash
   * Optimized query using row_to_json and md5 for fast comparison
   * Supports both single and composite primary keys
   */
  async fetchSourceBatch(
    pool: Pool,
    tableName: string,
    pkColumns: string[],
    lastPkValue: string | null,
    batchSize: number
  ): Promise<RowWithHash[]> {
    // Build composite key expression
    const pkExpression = this.buildPkExpression(pkColumns);
    
    // Keyset pagination: Use simple > comparison without explicit casting
    // PostgreSQL handles implicit type coercion (TEXT → native column type)
    // This works for all PK types: INT, BIGINT, VARCHAR, UUID, etc.
    // For composite keys, we concatenate with '::' delimiter
    // Skip NULL primary keys to avoid comparison issues
    const whereClause = lastPkValue 
      ? `WHERE ${pkExpression} IS NOT NULL AND ${pkExpression} > $1` 
      : `WHERE ${pkExpression} IS NOT NULL`;
    const params: any[] = lastPkValue ? [lastPkValue, batchSize] : [batchSize];
    const limitParamIndex = lastPkValue ? '$2' : '$1';

    // Optimized keyset pagination query:
    // - Uses index on primary key for O(log n) seek + O(k) scan
    // - No explicit type casting - let PostgreSQL handle it
    // - Constant performance regardless of table size
    // - row_to_json is efficient for serialization
    // - md5 hash computed once per row
    // - Excludes 'created_at' from hash (application timestamp, not blockchain data)
    const query = `
      SELECT 
        ${pkExpression} as pk,
        md5((row_to_json(t.*)::jsonb - 'created_at')::text) as row_hash,
        row_to_json(t.*) as row_data
      FROM ${tableName} t
      ${whereClause}
      ORDER BY ${pkExpression} ASC
      LIMIT ${limitParamIndex}
    `;

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Fetch rows from target database by primary key list
   * Optimized using ANY() for batch lookup
   * Supports both single and composite primary keys
   * Note: pkValues come from source query which already filters out NULLs
   */
  async fetchTargetRows(
    pool: Pool,
    tableName: string,
    pkColumns: string[],
    pkValues: any[]
  ): Promise<RowWithHash[]> {
    if (pkValues.length === 0) {
      return [];
    }

    // Build composite key expression
    const pkExpression = this.buildPkExpression(pkColumns);

    // Use ANY() for efficient batch lookup with index
    // PostgreSQL handles implicit type coercion for the array
    // No need to filter NULLs here - they're already excluded from pkValues
    // Excludes 'created_at' from hash (application timestamp, not blockchain data)
    const query = `
      SELECT 
        ${pkExpression} as pk,
        md5((row_to_json(t.*)::jsonb - 'created_at')::text) as row_hash,
        row_to_json(t.*) as row_data
      FROM ${tableName} t
      WHERE ${pkExpression} = ANY($1)
      ORDER BY ${pkExpression} ASC
    `;

    const result = await pool.query(query, [pkValues]);
    return result.rows;
  }

  /**
   * Log a mismatch between source and target
   * Uses batch insert for better performance
   */
  async logMismatch(
    jobId: number,
    tableName: string,
    pkValue: string,
    sourceRow: Record<string, any>,
    targetRow: Record<string, any>
  ): Promise<void> {
    await this.monitoringPool.query(
      `INSERT INTO table_verification_mismatches 
       (job_id, table_name, primary_key_value, source_row, target_row)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, tableName, pkValue, JSON.stringify(sourceRow), JSON.stringify(targetRow)]
    );
  }

  /**
   * Log a gap (missing row in target)
   */
  async logGap(
    jobId: number,
    tableName: string,
    pkValue: string,
    sourceRow: Record<string, any>
  ): Promise<void> {
    await this.monitoringPool.query(
      `INSERT INTO table_verification_gaps 
       (job_id, table_name, primary_key_value, source_row)
       VALUES ($1, $2, $3, $4)`,
      [jobId, tableName, pkValue, JSON.stringify(sourceRow)]
    );
  }

  /**
   * Batch log mismatches for better performance
   */
  async logMismatchesBatch(
    mismatches: Array<{
      jobId: number;
      tableName: string;
      pkValue: string;
      sourceRow: Record<string, any>;
      targetRow: Record<string, any>;
    }>
  ): Promise<void> {
    if (mismatches.length === 0) return;

    const values = mismatches.map((m, i) => {
      const base = i * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    }).join(', ');

    const params = mismatches.flatMap(m => [
      m.jobId,
      m.tableName,
      m.pkValue,
      JSON.stringify(m.sourceRow),
      JSON.stringify(m.targetRow),
    ]);

    await this.monitoringPool.query(
      `INSERT INTO table_verification_mismatches 
       (job_id, table_name, primary_key_value, source_row, target_row)
       VALUES ${values}`,
      params
    );
  }

  /**
   * Batch log gaps for better performance
   */
  async logGapsBatch(
    gaps: Array<{
      jobId: number;
      tableName: string;
      pkValue: string;
      sourceRow: Record<string, any>;
    }>
  ): Promise<void> {
    if (gaps.length === 0) return;

    const values = gaps.map((g, i) => {
      const base = i * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(', ');

    const params = gaps.flatMap(g => [
      g.jobId,
      g.tableName,
      g.pkValue,
      JSON.stringify(g.sourceRow),
    ]);

    await this.monitoringPool.query(
      `INSERT INTO table_verification_gaps 
       (job_id, table_name, primary_key_value, source_row)
       VALUES ${values}`,
      params
    );
  }

  /**
   * Update job state after processing a batch
   */
  async updateJobState(
    jobId: number,
    updates: {
      last_checked_pk_value: string;
      total_rows_checked: bigint;
      mismatches_found: number;
      gaps_found: number;
    }
  ): Promise<void> {
    await this.monitoringPool.query(
      `UPDATE table_verification_jobs 
       SET last_checked_pk_value = $1,
           total_rows_checked = $2,
           mismatches_found = $3,
           gaps_found = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [
        updates.last_checked_pk_value,
        updates.total_rows_checked,
        updates.mismatches_found,
        updates.gaps_found,
        jobId,
      ]
    );
  }

  /**
   * Mark job as completed
   */
  async completeJob(jobId: number): Promise<void> {
    await this.monitoringPool.query(
      `UPDATE table_verification_jobs 
       SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );
  }

  /**
   * Mark job as error and save error message
   */
  async markJobAsError(jobId: number, errorMessage: string): Promise<void> {
    await this.monitoringPool.query(
      `UPDATE table_verification_jobs 
       SET status = 'error', error_message = $1, updated_at = NOW()
       WHERE id = $2`,
      [errorMessage, jobId]
    );
  }

  /**
   * Get mismatches for a job with pagination
   * Ordered by primary key value (ascending) to show lower PKs first
   */
  async getMismatches(jobId: number, limit = 100, offset = 0): Promise<VerificationMismatch[]> {
    const result = await this.monitoringPool.query(
      `SELECT * FROM table_verification_mismatches 
       WHERE job_id = $1 
       ORDER BY primary_key_value ASC 
       LIMIT $2 OFFSET $3`,
      [jobId, limit, offset]
    );
    return result.rows;
  }

  /**
   * Get gaps for a job with pagination
   * Ordered by primary key value (ascending) to show lower PKs first
   */
  async getGaps(jobId: number, limit = 100, offset = 0): Promise<VerificationGap[]> {
    const result = await this.monitoringPool.query(
      `SELECT * FROM table_verification_gaps 
       WHERE job_id = $1 
       ORDER BY primary_key_value ASC 
       LIMIT $2 OFFSET $3`,
      [jobId, limit, offset]
    );
    return result.rows;
  }

  /**
   * Get total count of mismatches for a job
   */
  async getMismatchCount(jobId: number): Promise<number> {
    const result = await this.monitoringPool.query(
      'SELECT COUNT(*) as count FROM table_verification_mismatches WHERE job_id = $1',
      [jobId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get total count of gaps for a job
   */
  async getGapCount(jobId: number): Promise<number> {
    const result = await this.monitoringPool.query(
      'SELECT COUNT(*) as count FROM table_verification_gaps WHERE job_id = $1',
      [jobId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Delete a verification job and all related data by job ID
   */
  async deleteJob(jobId: number): Promise<void> {
    // CASCADE will automatically delete mismatches and gaps
    await this.monitoringPool.query(
      'DELETE FROM table_verification_jobs WHERE id = $1',
      [jobId]
    );
  }

  /**
   * Delete a verification job and all related data by table name
   */
  async deleteJobByTableName(tableName: string): Promise<void> {
    // CASCADE will automatically delete mismatches and gaps
    await this.monitoringPool.query(
      'DELETE FROM table_verification_jobs WHERE table_name = $1',
      [tableName]
    );
  }
}
