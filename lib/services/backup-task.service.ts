import { getDbPool } from '@/lib/db/connection';
import { createHash } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

export interface BackupTask {
  id: string;
  task_type: 'backup' | 'restore';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stalled';
  filename?: string;
  filepath?: string;
  file_size?: number;
  tables?: string[];
  exclude_tables?: string[];
  snapshot_id?: string;
  slot_name?: string;
  publication_name?: string;
  slot_initial_lsn?: string;
  connection_string_hash?: string;
  schema_only?: boolean;
  error_message?: string;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
  updated_at: Date;
  created_by?: string;
  metadata?: any;
}

export class BackupTaskService {
  /**
   * Hash connection string for privacy (don't store plain passwords)
   */
  private hashConnectionString(connString: string): string {
    return createHash('sha256').update(connString).digest('hex');
  }

  /**
   * Parse table names from comma or newline-separated string
   * Handles various formats: "public.table", 'public."Table"', table, etc.
   */
  private parseTableList(tableList: string | string[] | undefined): string[] {
    if (!tableList) {
      return [];
    }

    if (Array.isArray(tableList)) {
      return tableList;
    }

    // Split by comma or newline, trim whitespace, filter empty strings
    return tableList
      .split(/[,\n]/)
      .map(t => t.trim())
      .filter(t => t.length > 0);
  }

  /**
   * Normalize table name for pg_dump --exclude-table flag
   * Handles: "public.table", 'public."Table"', table, etc.
   * Returns: public."Table" or public.table (properly quoted)
   */
  protected normalizeTableName(tableName: string): string {
    // Remove existing quotes if present
    let cleaned = tableName.replace(/^["']|["']$/g, '').trim();

    // Split by dot to get schema and table
    const parts = cleaned.split('.');

    if (parts.length === 2) {
      const [schema, table] = parts;
      // Quote schema if it has uppercase or special chars
      const quotedSchema = /[A-Z]/.test(schema) || /[^a-z0-9_]/.test(schema) ? `"${schema}"` : schema;
      // Quote table if it has uppercase or special chars
      const quotedTable = /[A-Z]/.test(table) || /[^a-z0-9_]/.test(table) ? `"${table}"` : table;
      return `${quotedSchema}.${quotedTable}`;
    } else {
      // No schema specified, assume public
      const quotedTable = /[A-Z]/.test(cleaned) || /[^a-z0-9_]/.test(cleaned) ? `"${cleaned}"` : cleaned;
      return `public.${quotedTable}`;
    }
  }

  /**
   * Create a new backup task
   */
  async createTask(
    taskType: 'backup' | 'restore',
    options: {
      tables?: string[];
      excludeTables?: string[] | string;
      snapshotId?: string;
      slotName?: string;
      publicationName?: string;
      slotInitialLsn?: string;
      connectionString: string;
      schemaOnly?: boolean;
      filename?: string;
      createdBy?: string;
    }
  ): Promise<BackupTask> {
    const pool = getDbPool();
    const connHash = this.hashConnectionString(options.connectionString);

    // Parse exclude tables (can be array, comma-separated, or newline-separated)
    const excludeTables = this.parseTableList(options.excludeTables);

    const result = await pool.query(
      `INSERT INTO backup_tasks (
        task_type, status, tables, exclude_tables, snapshot_id, slot_name, publication_name, 
        slot_initial_lsn, connection_string_hash, schema_only, filename, created_by, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        taskType,
        'pending',
        options.tables || null,
        excludeTables.length > 0 ? excludeTables : null,
        options.snapshotId || null,
        options.slotName || null,
        options.publicationName || null,
        options.slotInitialLsn || null,
        connHash,
        options.schemaOnly || false,
        options.filename || null,
        options.createdBy || null,
        {},
      ]
    );

    return this.mapRowToTask(result.rows[0]);
  }

  /**
   * Update task status
   */
  async updateTask(
    taskId: string,
    updates: {
      status?: BackupTask['status'];
      filename?: string;
      filepath?: string;
      file_size?: number;
      error_message?: string;
      snapshot_id?: string;
      slot_name?: string;
      publication_name?: string;
      slot_initial_lsn?: string;
      metadata?: any;
    }
  ): Promise<BackupTask> {
    const pool = getDbPool();
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.status) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);

      // Set timestamps based on status
      if (updates.status === 'running') {
        setClauses.push(`started_at = NOW()`);
      } else if (updates.status === 'completed' || updates.status === 'failed' || updates.status === 'cancelled' || updates.status === 'stalled') {
        setClauses.push(`completed_at = NOW()`);
      }
    }

    if (updates.filename !== undefined) {
      setClauses.push(`filename = $${paramIndex++}`);
      values.push(updates.filename);
    }

    if (updates.filepath !== undefined) {
      setClauses.push(`filepath = $${paramIndex++}`);
      values.push(updates.filepath);
    }

    if (updates.file_size !== undefined) {
      setClauses.push(`file_size = $${paramIndex++}`);
      values.push(updates.file_size);
    }

    if (updates.error_message !== undefined) {
      setClauses.push(`error_message = $${paramIndex++}`);
      values.push(updates.error_message);
    }

    if (updates.snapshot_id !== undefined) {
      setClauses.push(`snapshot_id = $${paramIndex++}`);
      values.push(updates.snapshot_id);
    }

    if (updates.slot_name !== undefined) {
      setClauses.push(`slot_name = $${paramIndex++}`);
      values.push(updates.slot_name);
    }

    if (updates.publication_name !== undefined) {
      setClauses.push(`publication_name = $${paramIndex++}`);
      values.push(updates.publication_name);
    }

    if (updates.slot_initial_lsn !== undefined) {
      setClauses.push(`slot_initial_lsn = $${paramIndex++}`);
      values.push(updates.slot_initial_lsn);
    }

    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(updates.metadata));
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(taskId);

    const result = await pool.query(
      `UPDATE backup_tasks 
       SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error(`Task ${taskId} not found`);
    }

    return this.mapRowToTask(result.rows[0]);
  }

  /**
   * Get task by ID
   */
  async getTask(taskId: string): Promise<BackupTask | null> {
    const pool = getDbPool();
    const result = await pool.query('SELECT * FROM backup_tasks WHERE id = $1', [taskId]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToTask(result.rows[0]);
  }

  /**
   * List tasks with optional filters
   */
  async listTasks(filters?: {
    status?: BackupTask['status'];
    task_type?: 'backup' | 'restore';
    limit?: number;
    offset?: number;
  }): Promise<BackupTask[]> {
    const pool = getDbPool();
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (filters?.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(filters.status);
    }

    if (filters?.task_type) {
      conditions.push(`task_type = $${paramIndex++}`);
      values.push(filters.task_type);
    }

    let query = 'SELECT * FROM backup_tasks';
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC';

    if (filters?.limit) {
      query += ` LIMIT $${paramIndex++}`;
      values.push(filters.limit);
    }

    if (filters?.offset) {
      query += ` OFFSET $${paramIndex++}`;
      values.push(filters.offset);
    }

    const result = await pool.query(query, values);
    return result.rows.map(row => this.mapRowToTask(row));
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status !== 'running' && task.status !== 'pending') {
      throw new Error(`Task ${taskId} cannot be cancelled (status: ${task.status})`);
    }

    await this.updateTask(taskId, {
      status: 'cancelled',
      error_message: 'Cancelled by user',
    });

    console.log(`[backup-task] Task ${taskId} cancelled`);
  }

  /**
   * Delete task and optionally its backup file
   */
  async deleteTask(taskId: string, deleteFile: boolean = false): Promise<void> {
    const pool = getDbPool();

    // Get task first to check for file
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Delete file if requested and exists
    if (deleteFile && task.filepath) {
      try {
        await fs.unlink(task.filepath);
        console.log(`[backup-task] Deleted backup file: ${task.filepath}`);
      } catch (error) {
        console.warn(`[backup-task] Failed to delete file ${task.filepath}:`, error);
        // Continue with task deletion even if file deletion fails
      }
    }

    // Delete task from database
    await pool.query('DELETE FROM backup_tasks WHERE id = $1', [taskId]);
  }

  /**
   * Execute backup task in background
   */
  async executeBackupTask(taskId: string, connectionString: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status !== 'pending') {
      throw new Error(`Task ${taskId} is not in pending status`);
    }

    await this.updateTask(taskId, { status: 'running' });

    try {
      const backupDir = await this.getBackupDir();
      await fs.mkdir(backupDir, { recursive: true });

      // Parse connection string
      const conn = this.parseConnectionString(connectionString);

      // Generate filename using task ID
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `backup_${timestamp}_${taskId}.sql`;
      const filepath = path.join(backupDir, filename);

      // Set filepath immediately so file size polling can work while backup is running
      await this.updateTask(taskId, {
        filename,
        filepath,
      });

      // Build pg_dump command
      // Include tables (if specified)
      const tableArgs = (task.tables || []).map(t => {
        const normalized = this.normalizeTableName(t);
        return `-t ${normalized}`;
      }).join(' ');

      // Exclude tables (if specified)
      const excludeTableArgs = (task.exclude_tables || []).map(t => {
        const normalized = this.normalizeTableName(t);
        return `--exclude-table=${normalized}`;
      }).join(' ');

      const dataFlag = task.schema_only ? '--schema-only' : '';

      // Build command - note: if tables are specified, we use -t, otherwise we dump all and use --exclude-table
      const command = `PGPASSWORD='${conn.password.replace(/'/g, "\\'")}' pg_dump ` +
        `-h ${conn.host} ` +
        `-p ${conn.port} ` +
        `-U ${conn.user} ` +
        `-d ${conn.database} ` +
        `${dataFlag} ` +
        `--no-owner ` +
        `--no-privileges ` +
        `${tableArgs ? tableArgs + ' ' : ''}` +
        `${excludeTableArgs ? excludeTableArgs + ' ' : ''}` +
        `-f ${filepath}`;

      const tableCount = (task.tables || []).length;
      const excludeCount = (task.exclude_tables || []).length;
      const slotInfo = task.slot_name ? ` (slot: ${task.slot_name}${task.slot_initial_lsn ? `, LSN: ${task.slot_initial_lsn}` : ''})` : '';
      const snapshotInfo = task.snapshot_id ? ` (snapshot: ${task.snapshot_id})` : '';
      console.log(`[backup-task] Executing backup task ${taskId}: ${tableCount} tables${excludeCount > 0 ? `, ${excludeCount} excluded` : ''}${slotInfo}${snapshotInfo}`);

      // Execute backup
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 100 * 1024 * 1024,
        env: {
          ...process.env,
          PGPASSWORD: conn.password,
        },
      });

      // Check if task was cancelled during execution
      const currentTask = await this.getTask(taskId);
      if (currentTask?.status === 'cancelled') {
        // Clean up file if it was created
        try {
          await fs.unlink(filepath).catch(() => { });
        } catch { }
        console.log(`[backup-task] Backup task ${taskId} was cancelled, skipping completion`);
        return;
      }

      // Check if file was created
      const stats = await fs.stat(filepath);
      const fileSize = stats.size;

      await this.updateTask(taskId, {
        status: 'completed',
        filename,
        filepath,
        file_size: fileSize,
        metadata: {
          stdout: stdout || undefined,
          stderr: stderr || undefined,
          lastFileSizeUpdate: new Date().toISOString(),
        },
      });

      console.log(`[backup-task] Backup task ${taskId} completed: ${filename} (${fileSize} bytes)`);
    } catch (error: any) {
      // Check if task was cancelled
      const currentTask = await this.getTask(taskId);
      if (currentTask?.status === 'cancelled') {
        console.log(`[backup-task] Backup task ${taskId} was cancelled`);
        return;
      }

      console.error(`[backup-task] Backup task ${taskId} failed:`, error);
      await this.updateTask(taskId, {
        status: 'failed',
        error_message: error.message || 'Unknown error',
        metadata: {
          error: error.message,
          stderr: error.stderr || error.stdout,
        },
      });
      throw error;
    }
  }

  /**
   * Execute restore task in background
   * Automatically detects backup format and uses pg_restore for custom format, psql for plain SQL
   */
  async executeRestoreTask(taskId: string, connectionString: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status !== 'pending') {
      throw new Error(`Task ${taskId} is not in pending status`);
    }

    if (!task.filepath) {
      throw new Error(`Task ${taskId} has no filepath`);
    }

    await this.updateTask(taskId, { status: 'running' });

    try {
      const conn = this.parseConnectionString(connectionString);

      // Check if file exists
      await fs.access(task.filepath);

      // Detect backup format by file extension
      const isCustomFormat = task.filepath.endsWith('.dump') || task.filepath.endsWith('.backup');
      const isCompressed = task.filepath.endsWith('.gz');

      let command: string;

      if (isCustomFormat) {
        // Use pg_restore for custom format dumps
        command = `PGPASSWORD='${conn.password.replace(/'/g, "\\'")}' pg_restore ` +
          `-h ${conn.host} ` +
          `-p ${conn.port} ` +
          `-U ${conn.user} ` +
          `-d ${conn.database} ` +
          `--no-owner ` +
          `--no-privileges ` +
          `--verbose ` +
          `${task.filepath}`;
      } else if (isCompressed) {
        // Compressed SQL file - use gunzip + psql
        command = `PGPASSWORD='${conn.password.replace(/'/g, "\\'")}' gunzip -c ${task.filepath} | psql ` +
          `-h ${conn.host} ` +
          `-p ${conn.port} ` +
          `-U ${conn.user} ` +
          `-d ${conn.database} ` +
          `-q`;
      } else {
        // Plain SQL file - use psql
        command = `PGPASSWORD='${conn.password.replace(/'/g, "\\'")}' psql ` +
          `-h ${conn.host} ` +
          `-p ${conn.port} ` +
          `-U ${conn.user} ` +
          `-d ${conn.database} ` +
          `-f ${task.filepath}`;
      }

      console.log(`[backup-task] Executing restore task ${taskId}: ${task.filename} (format: ${isCustomFormat ? 'custom' : isCompressed ? 'compressed SQL' : 'plain SQL'})`);

      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 100 * 1024 * 1024, // Increased for large restores
        env: {
          ...process.env,
          PGPASSWORD: conn.password,
        },
        shell: '/bin/bash', // Required for pipe operations
      });

      await this.updateTask(taskId, {
        status: 'completed',
        metadata: {
          stdout: stdout || undefined,
          stderr: stderr || undefined,
          format: isCustomFormat ? 'custom' : isCompressed ? 'compressed SQL' : 'plain SQL',
        },
      });

      console.log(`[backup-task] Restore task ${taskId} completed`);
    } catch (error: any) {
      console.error(`[backup-task] Restore task ${taskId} failed:`, error);
      await this.updateTask(taskId, {
        status: 'failed',
        error_message: error.message || 'Unknown error',
        metadata: {
          error: error.message,
          stderr: error.stderr || error.stdout,
        },
      });
      throw error;
    }
  }

  /**
   * Get backup directory
   */
  protected async getBackupDir(): Promise<string> {
    if (process.env.BACKUP_DIR) {
      return process.env.BACKUP_DIR;
    }

    try {
      await fs.access('/backup');
      return '/backup';
    } catch {
      // For local runs, use ./backup in the project directory
      return path.join(process.cwd(), 'backup');
    }
  }

  /**
   * Parse connection string
   */
  protected parseConnectionString(connString: string) {
    try {
      const url = new URL(connString);
      return {
        host: url.hostname,
        port: url.port || '5432',
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.slice(1).split('?')[0],
      };
    } catch {
      const params: any = {};
      connString.split(' ').forEach(param => {
        const [key, value] = param.split('=');
        if (key && value) {
          params[key] = value;
        }
      });
      return {
        host: params.host || params.hostname,
        port: params.port || '5432',
        user: params.user || params.userid,
        password: params.password || params.pass,
        database: params.database || params.dbname,
      };
    }
  }

  /**
   * Map database row to BackupTask
   */
  private mapRowToTask(row: any): BackupTask {
    return {
      id: row.id,
      task_type: row.task_type,
      status: row.status,
      filename: row.filename,
      filepath: row.filepath,
      file_size: row.file_size ? Number(row.file_size) : undefined,
      tables: row.tables,
      exclude_tables: row.exclude_tables,
      snapshot_id: row.snapshot_id,
      slot_name: row.slot_name,
      publication_name: row.publication_name,
      slot_initial_lsn: row.slot_initial_lsn,
      connection_string_hash: row.connection_string_hash,
      schema_only: row.schema_only,
      error_message: row.error_message,
      started_at: row.started_at,
      completed_at: row.completed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by,
      metadata: row.metadata,
    };
  }

  /**
   * Check if a process is still running by PID
   */
  private async isProcessRunning(pid: number): Promise<boolean> {
    try {
      // On Unix-like systems, sending signal 0 checks if process exists
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      // ESRCH means process doesn't exist
      if (error.code === 'ESRCH') {
        return false;
      }
      // Other errors might mean permission denied, assume process exists
      return true;
    }
  }

  /**
   * Check for stalled backup and restore tasks and update their status
   * A task is considered stalled if:
   * 1. The process has exited but the task is still marked as running, OR
   * 2. It's been running but hasn't updated its status in more than 15 minutes (for large tables)
   * Note: File size not changing is NOT enough - we also check if process is running
   */
  async checkForStalledTasks(): Promise<{ checked: number; stalled: number }> {
    const pool = getDbPool();
    const STALL_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes (for large tables that take time)
    const now = new Date();

    // Get all running tasks (both backup and restore)
    const result = await pool.query(`
      SELECT * FROM backup_tasks 
      WHERE status = 'running'
      ORDER BY updated_at ASC
    `);

    let stalledCount = 0;

    for (const row of result.rows) {
      const task = this.mapRowToTask(row);
      let isStalled = false;
      let stallReason = '';

      // Check 1: If process PID exists, check if process is still running
      const metadata = task.metadata || {};
      const processPid = metadata.process_pid;

      if (processPid && typeof processPid === 'number') {
        const isRunning = await this.isProcessRunning(processPid);
        if (!isRunning) {
          isStalled = true;
          stallReason = `Process (PID ${processPid}) has exited but task is still marked as running`;
        }
      }

      // Check 2: Has the task been updated recently?
      if (!isStalled) {
        const timeSinceUpdate = now.getTime() - new Date(task.updated_at).getTime();
        if (timeSinceUpdate > STALL_THRESHOLD_MS) {
          isStalled = true;
          stallReason = `No status update for ${Math.round(timeSinceUpdate / 1000 / 60)} minutes`;
        }
      }

      // Check 3: For backup tasks, if file exists, has file size changed in the last 2 minutes?
      if (task.task_type === 'backup' && task.filepath && task.file_size !== undefined && !isStalled) {
        try {
          const stats = await fs.stat(task.filepath);
          const currentFileSize = stats.size;

          // Get last file size update from metadata
          const lastFileSizeUpdate = metadata.lastFileSizeUpdate
            ? new Date(metadata.lastFileSizeUpdate).getTime()
            : new Date(task.updated_at).getTime();

          const timeSinceFileSizeUpdate = now.getTime() - lastFileSizeUpdate;

          // If file size hasn't changed and it's been more than 2 minutes since last update
          if (currentFileSize === task.file_size && timeSinceFileSizeUpdate > STALL_THRESHOLD_MS) {
            isStalled = true;
            stallReason = `File size unchanged for ${Math.round(timeSinceFileSizeUpdate / 1000 / 60)} minutes`;
          } else if (currentFileSize !== task.file_size) {
            // File size changed, update the task with new size and timestamp
            await this.updateTask(task.id, {
              file_size: currentFileSize,
              metadata: {
                ...metadata,
                lastFileSizeUpdate: now.toISOString(),
              },
            });
          }
        } catch (error) {
          // File doesn't exist or can't be accessed - might be stalled
          const timeSinceUpdate = now.getTime() - new Date(task.updated_at).getTime();
          if (timeSinceUpdate > STALL_THRESHOLD_MS) {
            isStalled = true;
            stallReason = `File not accessible and no update for ${Math.round(timeSinceUpdate / 1000 / 60)} minutes`;
          }
        }
      }

      if (isStalled) {
        const taskTypeLabel = task.task_type === 'backup' ? 'Backup' : 'Restore';
        await this.updateTask(task.id, {
          status: 'stalled',
          error_message: `${taskTypeLabel} stalled: ${stallReason}`,
        });
        stalledCount++;
        console.log(`[backup-task] Marked ${task.task_type} task ${task.id} as stalled: ${stallReason}`);
      }
    }

    return {
      checked: result.rows.length,
      stalled: stalledCount,
    };
  }
}

