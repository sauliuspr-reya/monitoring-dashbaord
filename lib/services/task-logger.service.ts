import { getDbPool } from '@/lib/db/connection';
import { promises as fs } from 'fs';
import path from 'path';
import { existsSync } from 'fs';

export interface TaskLogEntry {
  id: string;
  task_id: string;
  log_type: 'stdout' | 'stderr';
  line_number: number;
  content: string;
  timestamp: Date;
}

export class TaskLoggerService {
  private readonly MAX_DB_LINES = 100; // Keep last 100 lines in DB
  
  /**
   * Get log directory - uses /backup/logs in production, ./backup/logs in project root for local
   */
  private getLogDirPath(): string {
    if (process.env.BACKUP_LOG_DIR) {
      return process.env.BACKUP_LOG_DIR;
    }
    
    // Try /backup/logs first (production/Kubernetes)
    if (existsSync('/backup')) {
      return '/backup/logs';
    }
    
    // For local runs, use ./backup/logs in the project directory
    return path.join(process.cwd(), 'backup', 'logs');
  }
  
  private readonly LOG_DIR = this.getLogDirPath();

  /**
   * Get log directory path, create if needed
   */
  private async getLogDir(): Promise<string> {
    await fs.mkdir(this.LOG_DIR, { recursive: true });
    return this.LOG_DIR;
  }

  /**
   * Get log file path for a task
   */
  private async getLogFilePath(taskId: string, type: 'stdout' | 'stderr'): Promise<string> {
    const logDir = await this.getLogDir();
    return path.join(logDir, `${taskId}.${type}.log`);
  }

  /**
   * Initialize logging for a task
   */
  async initializeTaskLogging(taskId: string): Promise<{ stdoutPath: string; stderrPath: string }> {
    const stdoutPath = await this.getLogFilePath(taskId, 'stdout');
    const stderrPath = await this.getLogFilePath(taskId, 'stderr');

    // Clear existing logs
    await fs.writeFile(stdoutPath, '').catch(() => {});
    await fs.writeFile(stderrPath, '').catch(() => {});

    // Update task with log paths
    const pool = getDbPool();
    await pool.query(
      `UPDATE backup_tasks SET log_filepath = $1 WHERE id = $2`,
      [stdoutPath, taskId]
    );

    return { stdoutPath, stderrPath };
  }

  /**
   * Append a line to log file and optionally to DB
   */
  async appendLog(
    taskId: string,
    type: 'stdout' | 'stderr',
    content: string,
    lineNumber: number,
    saveToDb: boolean = true
  ): Promise<void> {
    const logPath = await this.getLogFilePath(taskId, type);

    // Append to file
    await fs.appendFile(logPath, content + '\n');

    // Save to DB (only last N lines)
    if (saveToDb) {
      const pool = getDbPool();
      await pool.query(
        `INSERT INTO task_logs (task_id, log_type, line_number, content)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (task_id, log_type, line_number) DO UPDATE SET content = $4, timestamp = NOW()`,
        [taskId, type, lineNumber, content]
      );

      // Cleanup old lines (keep only last MAX_DB_LINES)
      await pool.query(
        `DELETE FROM task_logs
         WHERE task_id = $1 AND log_type = $2
         AND line_number < (SELECT MAX(line_number) - $3 FROM task_logs WHERE task_id = $1 AND log_type = $2)`,
        [taskId, type, this.MAX_DB_LINES]
      );

      // Update line count in task
      await pool.query(
        `UPDATE backup_tasks SET ${type === 'stdout' ? 'stdout_lines' : 'stderr_lines'} = $1 WHERE id = $2`,
        [lineNumber, taskId]
      );
    }
  }

  /**
   * Get recent logs from DB (fast access)
   */
  async getRecentLogs(
    taskId: string,
    limit: number = 100,
    logType?: 'stdout' | 'stderr'
  ): Promise<TaskLogEntry[]> {
    const pool = getDbPool();
    let query = `
      SELECT id, task_id, log_type, line_number, content, timestamp
      FROM task_logs
      WHERE task_id = $1
    `;
    const params: any[] = [taskId];

    if (logType) {
      query += ` AND log_type = $2`;
      params.push(logType);
    }

    query += ` ORDER BY line_number DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    return result.rows.map(row => ({
      id: row.id,
      task_id: row.task_id,
      log_type: row.log_type,
      line_number: row.line_number,
      content: row.content,
      timestamp: row.timestamp,
    })).reverse(); // Reverse to get chronological order
  }

  /**
   * Get full log file content
   */
  async getFullLog(taskId: string, type: 'stdout' | 'stderr'): Promise<string> {
    const logPath = await this.getLogFilePath(taskId, type);
    try {
      return await fs.readFile(logPath, 'utf-8');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return ''; // File doesn't exist yet
      }
      throw error;
    }
  }

  /**
   * Stream log file (for SSE/real-time updates)
   */
  async *streamLog(taskId: string, type: 'stdout' | 'stderr'): AsyncGenerator<string> {
    const logPath = await this.getLogFilePath(taskId, type);
    let lastPosition = 0;

    while (true) {
      try {
        const stats = await fs.stat(logPath).catch(() => null);
        if (!stats) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        if (stats.size > lastPosition) {
          const fileHandle = await fs.open(logPath, 'r');
          const buffer = Buffer.alloc(stats.size - lastPosition);
          await fileHandle.read(buffer, 0, buffer.length, lastPosition);
          await fileHandle.close();

          const newContent = buffer.toString('utf-8');
          if (newContent) {
            yield newContent;
          }
          lastPosition = stats.size;
        }

        await new Promise(resolve => setTimeout(resolve, 500)); // Poll every 500ms
      } catch (error) {
        console.error(`[task-logger] Error streaming log for ${taskId}:`, error);
        break;
      }
    }
  }

  /**
   * Clean up old log files (older than N days)
   */
  async cleanupOldLogs(daysToKeep: number = 7): Promise<number> {
    const logDir = await this.getLogDir();
    const files = await fs.readdir(logDir);
    const now = Date.now();
    const maxAge = daysToKeep * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const file of files) {
      if (file.endsWith('.log')) {
        const filePath = path.join(logDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            deleted++;
          }
        } catch (error) {
          // Ignore errors
        }
      }
    }

    return deleted;
  }
}

export const taskLoggerService = new TaskLoggerService();

