import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { BackupTaskService, BackupTask } from './backup-task.service';
import { taskLoggerService } from './task-logger.service';

/**
 * Enhanced backup task service with streaming output support
 * Uses spawn() instead of exec() to capture real-time stdout/stderr
 */
export class BackupTaskStreamingService extends BackupTaskService {
  private activeProcesses = new Map<string, ChildProcess>();

  /**
   * Execute backup task with streaming output
   */
  async executeBackupTaskStreaming(taskId: string, connectionString: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status !== 'pending') {
      throw new Error(`Task ${taskId} is not in pending status`);
    }

    await this.updateTask(taskId, { status: 'running' });

    // Initialize logging
    const { stdoutPath, stderrPath } = await taskLoggerService.initializeTaskLogging(taskId);

    let stdoutLineCount = 0;
    let stderrLineCount = 0;

    try {
      const backupDir = await this.getBackupDir();
      await fs.mkdir(backupDir, { recursive: true });

      const conn = this.parseConnectionString(connectionString);

      // Generate filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      let filename: string;
      if (task.tables && task.tables.length > 0) {
        const tableList = task.tables.slice(0, 3).join('_');
        filename = `backup_${timestamp}_${tableList}${task.tables.length > 3 ? `_and_${task.tables.length - 3}_more` : ''}.sql`;
      } else if (task.exclude_tables && task.exclude_tables.length > 0) {
        filename = `backup_${timestamp}_.sql`;
      } else {
        filename = `backup_${timestamp}_.sql`;
      }
      const filepath = path.join(backupDir, filename);

      await this.updateTask(taskId, {
        filename,
        filepath,
      });

      // Build pg_dump command arguments
      const args: string[] = [
        '-h', conn.host,
        '-p', conn.port.toString(),
        '-U', conn.user,
        '-d', conn.database,
      ];

      if (task.schema_only) {
        args.push('--schema-only');
      }

      args.push('--no-owner', '--no-privileges');

      // Add table includes
      if (task.tables && task.tables.length > 0) {
        for (const table of task.tables) {
          const normalized = this.normalizeTableName(table);
          args.push('-t', normalized);
        }
      }

      // Add table excludes
      if (task.exclude_tables && task.exclude_tables.length > 0) {
        for (const table of task.exclude_tables) {
          const normalized = this.normalizeTableName(table);
          args.push('--exclude-table', normalized);
        }
      }

      args.push('-f', filepath);

      // Spawn pg_dump process
      const childProcess = spawn('pg_dump', args, {
        env: {
          ...process.env,
          PGPASSWORD: conn.password,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeProcesses.set(taskId, childProcess);

      // Store PID
      await this.updateTask(taskId, {
        metadata: {
          ...task.metadata,
          process_pid: childProcess.pid,
        },
      });

      // Handle stdout
      childProcess.stdout?.on('data', async (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          stdoutLineCount++;
          await taskLoggerService.appendLog(taskId, 'stdout', line, stdoutLineCount);
        }
      });

      // Handle stderr
      childProcess.stderr?.on('data', async (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          stderrLineCount++;
          await taskLoggerService.appendLog(taskId, 'stderr', line, stderrLineCount);
        }
      });

      // Wait for process to complete
      await new Promise<void>((resolve, reject) => {
        childProcess.on('close', async (code) => {
          this.activeProcesses.delete(taskId);

          // Check if cancelled
          const currentTask = await this.getTask(taskId);
          if (currentTask?.status === 'cancelled') {
            try {
              await fs.unlink(filepath).catch(() => {});
            } catch {}
            return resolve();
          }

          if (code !== 0) {
            const errorMsg = `pg_dump exited with code ${code}`;
            await this.updateTask(taskId, {
              status: 'failed',
              error_message: errorMsg,
            });
            return reject(new Error(errorMsg));
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
              ...task.metadata,
              stdout_lines: stdoutLineCount,
              stderr_lines: stderrLineCount,
            },
          });

          resolve();
        });

        childProcess.on('error', async (error) => {
          this.activeProcesses.delete(taskId);
          await this.updateTask(taskId, {
            status: 'failed',
            error_message: error.message,
          });
          reject(error);
        });
      });

      // Update file size periodically during execution
      const sizeCheckInterval = setInterval(async () => {
        try {
          const stats = await fs.stat(filepath);
          await this.updateTask(taskId, {
            file_size: stats.size,
            metadata: {
              ...task.metadata,
              lastFileSizeUpdate: new Date().toISOString(),
            },
          });
        } catch (error) {
          // File might not exist yet
        }
      }, 2000); // Check every 2 seconds

      // Clear interval when done
      childProcess.on('close', () => clearInterval(sizeCheckInterval));

    } catch (error: any) {
      this.activeProcesses.delete(taskId);

      const currentTask = await this.getTask(taskId);
      if (currentTask?.status === 'cancelled') {
        return;
      }

      await this.updateTask(taskId, {
        status: 'failed',
        error_message: error.message || 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    const childProcess = this.activeProcesses.get(taskId);
    if (childProcess) {
      childProcess.kill('SIGTERM');
      this.activeProcesses.delete(taskId);
    }

    await this.updateTask(taskId, {
      status: 'cancelled',
      error_message: 'Task cancelled by user',
    });
  }

  /**
   * Execute restore task with streaming output
   */
  async executeRestoreTaskStreaming(taskId: string, connectionString: string): Promise<void> {
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

    // Initialize logging
    const { stdoutPath, stderrPath } = await taskLoggerService.initializeTaskLogging(taskId);

    let stdoutLineCount = 0;
    let stderrLineCount = 0;

    try {
      const conn = this.parseConnectionString(connectionString);
      await fs.access(task.filepath);

      const isCustomFormat = task.filepath.endsWith('.dump') || task.filepath.endsWith('.backup');
      const isCompressed = task.filepath.endsWith('.gz');

      let childProcess: ChildProcess;

      if (isCustomFormat) {
        // Use pg_restore for custom format
        const args = [
          '-h', conn.host,
          '-p', conn.port.toString(),
          '-U', conn.user,
          '-d', conn.database,
          '--no-owner',
          '--no-privileges',
          '--verbose',
          task.filepath,
        ];

        childProcess = spawn('pg_restore', args, {
          env: {
            ...process.env,
            PGPASSWORD: conn.password,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        // Use psql for plain SQL
        if (isCompressed) {
          // Use gunzip | psql pipeline
          const gunzip = spawn('gunzip', ['-c', task.filepath]);
          const psql = spawn('psql', [
            '-h', conn.host,
            '-p', conn.port.toString(),
            '-U', conn.user,
            '-d', conn.database,
          ], {
            env: {
              ...process.env,
              PGPASSWORD: conn.password,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          gunzip.stdout?.pipe(psql.stdin!);
          // Handle gunzip stderr separately
          gunzip.stderr?.on('data', async (data: Buffer) => {
            const lines = data.toString('utf-8').split('\n').filter(l => l.length > 0);
            for (const line of lines) {
              stderrLineCount++;
              await taskLoggerService.appendLog(taskId, 'stderr', `[gunzip] ${line}`, stderrLineCount);
            }
          });
          childProcess = psql;
        } else {
          const args = [
            '-h', conn.host,
            '-p', conn.port.toString(),
            '-U', conn.user,
            '-d', conn.database,
            '-f', task.filepath,
          ];

          childProcess = spawn('psql', args, {
            env: {
              ...process.env,
              PGPASSWORD: conn.password,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }
      }

      this.activeProcesses.set(taskId, childProcess);

      // Store PID for stalled detection
      await this.updateTask(taskId, {
        metadata: {
          ...task.metadata,
          process_pid: childProcess.pid,
        },
      });

      // Handle stdout
      childProcess.stdout?.on('data', async (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          stdoutLineCount++;
          await taskLoggerService.appendLog(taskId, 'stdout', line, stdoutLineCount);
        }
      });

      // Handle stderr
      childProcess.stderr?.on('data', async (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          stderrLineCount++;
          await taskLoggerService.appendLog(taskId, 'stderr', line, stderrLineCount);
        }
      });

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        childProcess.on('close', async (code) => {
          this.activeProcesses.delete(taskId);

          const currentTask = await this.getTask(taskId);
          if (currentTask?.status === 'cancelled') {
            return resolve();
          }

          if (code !== 0) {
            const errorMsg = `Restore exited with code ${code}`;
            await this.updateTask(taskId, {
              status: 'failed',
              error_message: errorMsg,
            });
            return reject(new Error(errorMsg));
          }

          await this.updateTask(taskId, {
            status: 'completed',
            metadata: {
              ...task.metadata,
              stdout_lines: stdoutLineCount,
              stderr_lines: stderrLineCount,
            },
          });

          resolve();
        });

        childProcess.on('error', async (error) => {
          this.activeProcesses.delete(taskId);
          await this.updateTask(taskId, {
            status: 'failed',
            error_message: error.message,
          });
          reject(error);
        });
      });

    } catch (error: any) {
      this.activeProcesses.delete(taskId);

      const currentTask = await this.getTask(taskId);
      if (currentTask?.status === 'cancelled') {
        return;
      }

      await this.updateTask(taskId, {
        status: 'failed',
        error_message: error.message || 'Unknown error',
      });
      throw error;
    }
  }
}

export const backupTaskStreamingService = new BackupTaskStreamingService();

