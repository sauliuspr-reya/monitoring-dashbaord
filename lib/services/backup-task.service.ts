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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  filename?: string;
  filepath?: string;
  file_size?: number;
  tables?: string[];
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
   * Create a new backup task
   */
  async createTask(
    taskType: 'backup' | 'restore',
    options: {
      tables?: string[];
      connectionString: string;
      schemaOnly?: boolean;
      filename?: string;
      createdBy?: string;
    }
  ): Promise<BackupTask> {
    const pool = getDbPool();
    const connHash = this.hashConnectionString(options.connectionString);

    const result = await pool.query(
      `INSERT INTO backup_tasks (
        task_type, status, tables, connection_string_hash, 
        schema_only, filename, created_by, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        taskType,
        'pending',
        options.tables || null,
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
      } else if (updates.status === 'completed' || updates.status === 'failed' || updates.status === 'cancelled') {
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

      // Generate filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const tableList = (task.tables || []).slice(0, 3).join('_');
      const filename = `backup_${timestamp}_${tableList}${(task.tables?.length || 0) > 3 ? `_and_${(task.tables?.length || 0) - 3}_more` : ''}.sql`;
      const filepath = path.join(backupDir, filename);

      // Build pg_dump command
      const tableArgs = (task.tables || []).map(t => {
        let tableName = t.includes('.') ? t : `public.${t}`;
        const parts = tableName.split('.');
        if (parts.length === 2) {
          const [schema, table] = parts;
          const quotedSchema = /[A-Z]/.test(schema) ? `"${schema}"` : schema;
          const quotedTable = /[A-Z]/.test(table) || /[^a-z0-9_]/.test(table) ? `"${table}"` : table;
          return `-t ${quotedSchema}.${quotedTable}`;
        } else {
          const quoted = /[A-Z]/.test(tableName) || /[^a-z0-9_]/.test(tableName) ? `"${tableName}"` : tableName;
          return `-t ${quoted}`;
        }
      }).join(' ');

      const dataFlag = task.schema_only ? '--schema-only' : '';
      
      const command = `PGPASSWORD='${conn.password.replace(/'/g, "\\'")}' pg_dump ` +
        `-h ${conn.host} ` +
        `-p ${conn.port} ` +
        `-U ${conn.user} ` +
        `-d ${conn.database} ` +
        `${dataFlag} ` +
        `--no-owner ` +
        `--no-privileges ` +
        `${tableArgs} ` +
        `-f ${filepath}`;

      console.log(`[backup-task] Executing backup task ${taskId}: ${(task.tables || []).length} tables`);

      // Execute backup
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 100 * 1024 * 1024,
        env: {
          ...process.env,
          PGPASSWORD: conn.password,
        },
      });

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
        },
      });

      console.log(`[backup-task] Backup task ${taskId} completed: ${filename} (${fileSize} bytes)`);
    } catch (error: any) {
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

      const command = `PGPASSWORD='${conn.password.replace(/'/g, "\\'")}' psql ` +
        `-h ${conn.host} ` +
        `-p ${conn.port} ` +
        `-U ${conn.user} ` +
        `-d ${conn.database} ` +
        `-f ${task.filepath}`;

      console.log(`[backup-task] Executing restore task ${taskId}: ${task.filename}`);

      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          PGPASSWORD: conn.password,
        },
      });

      await this.updateTask(taskId, {
        status: 'completed',
        metadata: {
          stdout: stdout || undefined,
          stderr: stderr || undefined,
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
  private async getBackupDir(): Promise<string> {
    if (process.env.BACKUP_DIR) {
      return process.env.BACKUP_DIR;
    }
    
    try {
      await fs.access('/backup');
      return '/backup';
    } catch {
      return './backup';
    }
  }

  /**
   * Parse connection string
   */
  private parseConnectionString(connString: string) {
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
}

