import { Pool } from 'pg';
import { getDbPool, createSourceTargetPool } from '../db/connection';
import {
  VerificationJob,
  VerificationMismatch,
  VerificationGap,
  VerificationGapRange,
  GapRecheckResult,
  RowWithHash,
  VerificationConfig,
} from '../types/verification.types';

type TimestampStrategy = 'timestamp' | 'timestamptz' | 'epoch_seconds' | 'epoch_millis';

interface TimestampColumnInfo {
  columnName: string;
  dataType: string;
  strategy: TimestampStrategy;
  score: number;
}

interface TimelineBucket {
  hour: string;
  rowCount: number;
  mismatchCount: number;
  gapCount: number;
}

export interface VerificationTimeline {
  timestampColumn: string | null;
  buckets: TimelineBucket[];
  warnings: string[];
  hoursEvaluated: number;
}

export class VerificationService {
  private monitoringPool: Pool;

  constructor() {
    this.monitoringPool = getDbPool();
  }

  private readonly NUMERIC_TYPES = new Set([
    'bigint',
    'integer',
    'numeric',
    'double precision',
    'real',
    'smallint',
  ]);

  private readonly TIMELINE_DISABLED_TABLES = new Set([
    'account_balances',
  ]);

  private parsePkBigInt(value: string | null | undefined): bigint | null {
    if (value == null) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private parseTableName(tableName: string): { schema: string; table: string } {
    const trimmed = tableName.trim();
    const stripQuotes = (value: string) => value.replace(/^"+|"+$/g, '');

    if (trimmed.includes('.')) {
      const [schemaPart, tablePart] = trimmed.split('.');
      return {
        schema: stripQuotes(schemaPart),
        table: stripQuotes(tablePart),
      };
    }

    return {
      schema: 'public',
      table: stripQuotes(trimmed),
    };
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private isTimestampLikeColumn(columnName: string, dataType: string): boolean {
    const lowerName = columnName.toLowerCase();
    const lowerType = dataType.toLowerCase();

    if (lowerType.includes('timestamp') || lowerType.includes('date')) {
      return true;
    }

    if (this.NUMERIC_TYPES.has(lowerType)) {
      if (
        lowerName.includes('timestamp') ||
        lowerName.includes('time') ||
        lowerName.includes('block') ||
        lowerName.includes('event')
      ) {
        return true;
      }
    }

    return false;
  }

  private determineTimestampStrategy(columnName: string, dataType: string): TimestampStrategy {
    const lowerType = dataType.toLowerCase();
    const lowerName = columnName.toLowerCase();

    if (lowerType.includes('timestamp with time zone')) {
      return 'timestamptz';
    }

    if (lowerType.includes('timestamp')) {
      return 'timestamp';
    }

    if (this.NUMERIC_TYPES.has(lowerType)) {
      if (lowerName.includes('millis') || lowerName.endsWith('_ms')) {
        return 'epoch_millis';
      }
      return 'epoch_seconds';
    }

    return 'timestamp';
  }

  private scoreTimestampColumn(columnName: string, dataType: string): number {
    const lowerName = columnName.toLowerCase();
    const lowerType = dataType.toLowerCase();

    const priorityRules: Array<{ regex: RegExp; weight: number }> = [
      { regex: /^blocktimestamp$/, weight: 100 },
      { regex: /^block_timestamp$/, weight: 95 },
      { regex: /^blocktime$/, weight: 90 },
      { regex: /block/, weight: 80 },
      { regex: /event.*time/, weight: 70 },
      { regex: /event.*seq/, weight: 60 },
      { regex: /timestamp/, weight: 50 },
      { regex: /created_at/, weight: 40 },
      { regex: /updated_at/, weight: 20 },
    ];

    let score = 0;
    for (const rule of priorityRules) {
      if (rule.regex.test(lowerName)) {
        score = Math.max(score, rule.weight);
        break;
      }
    }

    if (lowerType.includes('timestamp')) {
      score += 30;
    } else if (this.NUMERIC_TYPES.has(lowerType)) {
      score += 10;
    }

    return score;
  }

  private buildTimestampExpression(info: TimestampColumnInfo, columnRef: string): string {
    switch (info.strategy) {
      case 'timestamptz':
        return `${columnRef}::timestamptz`;
      case 'timestamp':
        return `${columnRef}::timestamp`;
      case 'epoch_millis':
        return `to_timestamp(${columnRef}::double precision / 1000.0)`;
      case 'epoch_seconds':
      default:
        return `to_timestamp(${columnRef}::double precision)`;
    }
  }

  private buildJsonTimestampExpression(info: TimestampColumnInfo, jsonAccessor: string): string {
    const safeAccessor = `NULLIF(${jsonAccessor}, '')`;
    switch (info.strategy) {
      case 'timestamptz':
      case 'timestamp':
        return `(${safeAccessor})::timestamp`;
      case 'epoch_millis':
        return `to_timestamp((${safeAccessor})::double precision / 1000.0)`;
      case 'epoch_seconds':
      default:
        return `to_timestamp((${safeAccessor})::double precision)`;
    }
  }

  private async detectTimestampColumn(pool: Pool, schema: string, table: string): Promise<TimestampColumnInfo | null> {
    const columnResult = await pool.query(
      `
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
      `,
      [schema, table]
    );

    const candidates: TimestampColumnInfo[] = [];

    for (const row of columnResult.rows) {
      const columnName: string = row.column_name;
      const dataType: string = row.data_type;

      if (!this.isTimestampLikeColumn(columnName, dataType)) {
        continue;
      }

      const strategy = this.determineTimestampStrategy(columnName, dataType);
      const score = this.scoreTimestampColumn(columnName, dataType);

      candidates.push({
        columnName,
        dataType,
        strategy,
        score,
      });
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  private buildTimeWindowClause(hours: number | null, columnAlias = 'ts'): string {
    if (!hours) {
      return '';
    }
    const clamped = Math.max(1, Math.min(hours, 24 * 30)); // limit to 30 days of hours
    return `AND ${columnAlias} >= NOW() - INTERVAL '${clamped} hours'`;
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

  private buildPkTextExpression(pkColumns: string[]): string {
    const expr = this.buildPkExpression(pkColumns);
    if (pkColumns.length === 1) {
      return `${expr}::text`;
    }
    return `(${expr})::text`;
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

  async getGapRanges(jobId: number, limit = 10000): Promise<VerificationGapRange[]> {
    const result = await this.monitoringPool.query(
      `SELECT id, primary_key_value, source_row, detected_at
       FROM table_verification_gaps
       WHERE job_id = $1
       ORDER BY primary_key_value ASC
       LIMIT $2`,
      [jobId, limit]
    );

    if (result.rows.length === 0) {
      return [];
    }

    const sorted = result.rows
      .map((row: any) => ({
        id: row.id,
        pkValue: row.primary_key_value as string,
        sourceRow: row.source_row as Record<string, any>,
        detectedAt: row.detected_at as Date,
        numericPk: this.parsePkBigInt(row.primary_key_value),
      }))
      .sort((a, b) => {
        if (a.numericPk !== null && b.numericPk !== null) {
          return a.numericPk < b.numericPk ? -1 : a.numericPk > b.numericPk ? 1 : 0;
        }
        return a.pkValue.localeCompare(b.pkValue);
      });

    const ranges: VerificationGapRange[] = [];

    let current = {
      startPk: sorted[0].pkValue,
      endPk: sorted[0].pkValue,
      numericEnd: sorted[0].numericPk,
      count: 1,
      detectedAt: sorted[0].detectedAt,
      sampleSourceRow: sorted[0].sourceRow,
    };

    const pushCurrent = () => {
      ranges.push({
        startPk: current.startPk,
        endPk: current.endPk,
        count: current.count,
        detectedAt: current.detectedAt,
        sampleSourceRow: current.sampleSourceRow,
      });
    };

    for (let i = 1; i < sorted.length; i++) {
      const row = sorted[i];
      const isSequential =
        current.numericEnd !== null &&
        row.numericPk !== null &&
        row.numericPk === current.numericEnd + BigInt(1);

      if (isSequential) {
        current.endPk = row.pkValue;
        current.numericEnd = row.numericPk;
        current.count += 1;
      } else {
        pushCurrent();
        current = {
          startPk: row.pkValue,
          endPk: row.pkValue,
          numericEnd: row.numericPk,
          count: 1,
          detectedAt: row.detectedAt,
          sampleSourceRow: row.sourceRow,
        };
      }
    }

    pushCurrent();

    return ranges;
  }

  /**
   * Restore missing gaps onto the target database
   * Reads gaps from table_verification_gaps and inserts them into target
   */
  async restoreGaps(jobId: number, targetPool: Pool): Promise<{ restored: number; errors: number }> {
    // Get all gaps for the job (fetch in batches to avoid memory issues)
    const batchSize = 1000;
    let offset = 0;
    let restored = 0;
    let errors = 0;

    while (true) {
      const gaps = await this.getGaps(jobId, batchSize, offset);

      if (gaps.length === 0) {
        break;
      }

      for (const gap of gaps) {
        try {
          const { table_name, source_row } = gap;
          const rowData = source_row as Record<string, any>;

          // Construct INSERT statement
          const columns = Object.keys(rowData);
          if (columns.length === 0) continue;

          const values = Object.values(rowData);
          const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
          const columnNames = columns.map(c => `"${c}"`).join(', '); // Quote columns

          // Handle schema/table name parsing
          const { schema, table } = this.parseTableName(table_name);
          const quotedTableName = `"${schema}"."${table}"`;

          // Use ON CONFLICT DO NOTHING to avoid errors if row appeared in the meantime
          const query = `INSERT INTO ${quotedTableName} (${columnNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

          await targetPool.query(query, values);
          restored++;
        } catch (err) {
          console.error(`Failed to restore gap ${gap.id}:`, err);
          errors++;
        }
      }

      offset += batchSize;
    }

    return { restored, errors };
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

  async recheckGaps(
    jobId: number,
    options: { limit?: number; chunkSize?: number } = {}
  ): Promise<GapRecheckResult> {
    const job = await this.getJobById(jobId);
    if (!job) {
      throw new Error('Verification job not found');
    }

    const targetUrl = process.env.TARGET_DATABASE_URL;
    if (!targetUrl) {
      throw new Error('TARGET_DATABASE_URL not configured');
    }

    const limit = options.limit ?? 5000;
    const chunkSize = Math.max(50, Math.min(options.chunkSize ?? 500, 2000));

    const gapsResult = await this.monitoringPool.query(
      `SELECT id, primary_key_value 
       FROM table_verification_gaps 
       WHERE job_id = $1 
       ORDER BY primary_key_value ASC 
       LIMIT $2`,
      [jobId, limit]
    );

    if (gapsResult.rows.length === 0) {
      return { rechecked: 0, resolved: 0, remaining: 0 };
    }

    const { schema, table } = this.parseTableName(job.table_name);
    const safeTableName = `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`;
    const pkTextExpr = this.buildPkTextExpression(job.primary_key_columns);

    const targetPool = createSourceTargetPool(targetUrl);
    let resolved = 0;
    let rechecked = 0;

    try {
      for (let i = 0; i < gapsResult.rows.length; i += chunkSize) {
        const chunk = gapsResult.rows.slice(i, i + chunkSize);
        const pkValues = chunk.map((row: any) => row.primary_key_value);
        rechecked += chunk.length;

        const existing = await targetPool.query(
          `SELECT ${pkTextExpr} AS pk_value 
           FROM ${safeTableName} 
           WHERE ${pkTextExpr} = ANY($1::text[])`,
          [pkValues]
        );

        const foundSet = new Set(existing.rows.map((row: any) => row.pk_value));
        const idsToDelete = chunk
          .filter((row: any) => foundSet.has(row.primary_key_value))
          .map((row: any) => row.id);

        if (idsToDelete.length > 0) {
          await this.monitoringPool.query(
            `DELETE FROM table_verification_gaps 
             WHERE id = ANY($1::int[])`,
            [idsToDelete]
          );
          resolved += idsToDelete.length;
        }
      }
    } finally {
      await targetPool.end();
    }

    const remaining = await this.getGapCount(jobId);
    return { rechecked, resolved, remaining };
  }

  /**
   * Build an hourly histogram of source rows along with mismatch/gap overlays.
   * Returns empty buckets when no timestamp column can be detected.
   */
  async getTimelineData(tableName: string, jobId: number, hours?: number): Promise<VerificationTimeline> {
    const hoursWindow = hours && Number.isFinite(hours) ? Number(hours) : 168;
    const warnings: string[] = [];
    const bucketMap = new Map<string, TimelineBucket>();

    const sourceUrl = process.env.SOURCE_DATABASE_URL;
    if (!sourceUrl) {
      warnings.push('SOURCE_DATABASE_URL is not configured');
      return { timestampColumn: null, buckets: [], warnings, hoursEvaluated: hoursWindow };
    }

    const { schema, table } = this.parseTableName(tableName);

    if (this.TIMELINE_DISABLED_TABLES.has(table.toLowerCase())) {
      warnings.push(`Timeline disabled for ${table}. This table does not store per-row timestamps.`);
      return { timestampColumn: null, buckets: [], warnings, hoursEvaluated: hoursWindow };
    }

    const safeSchema = this.quoteIdentifier(schema);
    const safeTable = this.quoteIdentifier(table);
    const fullTableRef = `${safeSchema}.${safeTable}`;
    const tableAlias = 'src';

    const sourcePool = createSourceTargetPool(sourceUrl);
    try {
      const timestampColumn = await this.detectTimestampColumn(sourcePool, schema, table);

      if (!timestampColumn) {
        warnings.push('No timestamp-like column detected. Run analyze-table-timestamps.sh to inspect columns.');
        return { timestampColumn: null, buckets: [], warnings, hoursEvaluated: hoursWindow };
      }

      const columnRef = `${tableAlias}.${this.quoteIdentifier(timestampColumn.columnName)}`;
      const timestampExpr = this.buildTimestampExpression(timestampColumn, columnRef);
      const timeWindowClause = this.buildTimeWindowClause(hoursWindow, 'ts');

      const sourceQuery = `
        WITH extracted AS (
          SELECT ${timestampExpr} AS ts
          FROM ${fullTableRef} ${tableAlias}
          WHERE ${timestampExpr} IS NOT NULL
        )
        SELECT date_trunc('hour', ts) AS hour_bucket, COUNT(*) AS row_count
        FROM extracted
        WHERE ts IS NOT NULL
        ${timeWindowClause}
        GROUP BY hour_bucket
        ORDER BY hour_bucket
      `;

      const mismatchTimestampExpr = this.buildJsonTimestampExpression(
        timestampColumn,
        `table_verification_mismatches.source_row ->> '${timestampColumn.columnName}'`
      );
      const gapTimestampExpr = this.buildJsonTimestampExpression(
        timestampColumn,
        `table_verification_gaps.source_row ->> '${timestampColumn.columnName}'`
      );

      const mismatchQuery = `
        WITH extracted AS (
          SELECT ${mismatchTimestampExpr} AS ts
          FROM table_verification_mismatches
          WHERE job_id = $1
        )
        SELECT date_trunc('hour', ts) AS hour_bucket, COUNT(*) AS mismatch_count
        FROM extracted
        WHERE ts IS NOT NULL
        ${timeWindowClause}
        GROUP BY hour_bucket
        ORDER BY hour_bucket
      `;

      const gapQuery = `
        WITH extracted AS (
          SELECT ${gapTimestampExpr} AS ts
          FROM table_verification_gaps
          WHERE job_id = $1
        )
        SELECT date_trunc('hour', ts) AS hour_bucket, COUNT(*) AS gap_count
        FROM extracted
        WHERE ts IS NOT NULL
        ${timeWindowClause}
        GROUP BY hour_bucket
        ORDER BY hour_bucket
      `;

      const [sourceBuckets, mismatchBuckets, gapBuckets] = await Promise.all([
        sourcePool.query(sourceQuery),
        this.monitoringPool.query(mismatchQuery, [jobId]),
        this.monitoringPool.query(gapQuery, [jobId]),
      ]);

      const ensureBucket = (isoHour: string) => {
        if (!bucketMap.has(isoHour)) {
          bucketMap.set(isoHour, {
            hour: isoHour,
            rowCount: 0,
            mismatchCount: 0,
            gapCount: 0,
          });
        }
        return bucketMap.get(isoHour)!;
      };

      for (const row of sourceBuckets.rows) {
        const iso = new Date(row.hour_bucket).toISOString();
        const bucket = ensureBucket(iso);
        bucket.rowCount = Number(row.row_count);
      }

      for (const row of mismatchBuckets.rows) {
        const iso = new Date(row.hour_bucket).toISOString();
        const bucket = ensureBucket(iso);
        bucket.mismatchCount = Number(row.mismatch_count);
      }

      for (const row of gapBuckets.rows) {
        const iso = new Date(row.hour_bucket).toISOString();
        const bucket = ensureBucket(iso);
        bucket.gapCount = Number(row.gap_count);
      }

      const buckets = Array.from(bucketMap.values()).sort(
        (a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime()
      );

      return {
        timestampColumn: timestampColumn.columnName,
        buckets,
        warnings,
        hoursEvaluated: Math.max(1, Math.min(hoursWindow, 24 * 30)),
      };
    } catch (error) {
      warnings.push('Failed to build timeline: ' + (error as Error).message);
      return { timestampColumn: null, buckets: [], warnings, hoursEvaluated: hoursWindow };
    } finally {
      await sourcePool.end();
    }
  }
}
