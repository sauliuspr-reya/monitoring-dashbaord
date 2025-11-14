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

    const startTime = Date.now();
    await this.updateTask(taskId, { 
      status: 'running',
      metadata: {
        ...task.metadata,
        startTime: startTime,
      },
    });

    // Initialize logging
    const { stdoutPath, stderrPath } = await taskLoggerService.initializeTaskLogging(taskId);

    let stdoutLineCount = 0;
    let stderrLineCount = 0;

    try {
      const backupDir = await this.getBackupDir();
      await fs.mkdir(backupDir, { recursive: true });

      const conn = this.parseConnectionString(connectionString);

      // Generate filename using task ID
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `backup_${timestamp}_${taskId}.sql`;
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

      args.push('--no-owner', '--no-privileges', '--verbose');

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

      // Instead of using -f flag, we'll pipe stdout to file using shell
      // This allows us to capture verbose stderr output while stdout goes to file
      // Build the command as a shell string
      const escapedPassword = conn.password.replace(/'/g, "'\"'\"'");
      const escapedFilepath = filepath.replace(/'/g, "'\"'\"'");
      const argsString = args.map(arg => {
        // Escape arguments that might contain special characters
        if (arg.includes(' ') || arg.includes("'") || arg.includes('"')) {
          return `'${arg.replace(/'/g, "'\"'\"'")}'`;
        }
        return arg;
      }).join(' ');
      
      // Use shell to redirect stdout to file, stderr goes to stderr pipe (which we capture)
      // pg_dump sends backup data to stdout and verbose progress to stderr
      const shellCommand = `PGPASSWORD='${escapedPassword}' pg_dump ${argsString} > '${escapedFilepath}'`;

      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Executing: ${shellCommand.replace(/PGPASSWORD='[^']+'/, "PGPASSWORD='***'")}`, stdoutLineCount).catch(() => {});

      // Spawn shell process to execute the command
      const childProcess = spawn('/bin/sh', ['-c', shellCommand], {
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

      // Log initial command info with paths
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Starting backup: ${filename}`, stdoutLineCount).catch(err => {
        console.error(`[backup-streaming] Error logging initial message:`, err);
      });
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Backup directory: ${backupDir}`, stdoutLineCount).catch(() => {});
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Full file path: ${filepath}`, stdoutLineCount).catch(() => {});
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Log files (persistent): ${stdoutPath}, ${stderrPath}`, stdoutLineCount).catch(() => {});
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Tables: ${task.tables?.length || 0}, Excluded: ${task.exclude_tables?.length || 0}`, stdoutLineCount).catch(() => {});
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Command: pg_dump ${args.join(' ').replace(/PGPASSWORD=[^\s]+/g, 'PGPASSWORD=***')}`, stdoutLineCount).catch(() => {});

      // With shell redirection (> file), stdout goes to file, stderr goes to stderr pipe
      // pg_dump sends backup SQL to stdout (redirected to file) and verbose progress to stderr
      // So stdout pipe will be empty, but stderr will have all the verbose output
      
      // Handle stdout (should be empty since it's redirected to file via shell)
      childProcess.stdout?.on('data', async (data: Buffer) => {
        const text = data.toString('utf-8');
        if (text.trim().length > 0) {
          // This shouldn't happen, but log it if it does
          const lines = text.split('\n').filter(l => l.trim().length > 0);
          for (const line of lines) {
            stdoutLineCount++;
            await taskLoggerService.appendLog(taskId, 'stdout', `[Unexpected stdout] ${line.trim()}`, stdoutLineCount).catch(err => {
              console.error(`[backup-streaming] Error appending log line:`, err);
            });
          }
        }
      });

      // Handle stderr - this contains all the verbose output from pg_dump
      // pg_dump sends progress messages, table dumps, etc. to stderr
      childProcess.stderr?.on('data', async (data: Buffer) => {
        const text = data.toString('utf-8');
        // Preserve all lines including empty ones for formatting
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Log the line (skip only the last empty line from split if it's truly empty)
          if (line.length > 0 || i < lines.length - 1) {
            stderrLineCount++;
            await taskLoggerService.appendLog(taskId, 'stderr', line, stderrLineCount).catch(err => {
              console.error(`[backup-streaming] Error appending stderr log line:`, err);
            });
          }
          
          // Check for error patterns
          const errorLine = line.trim().toLowerCase();
          if (errorLine.includes('fatal') || errorLine.includes('error') || 
              (errorLine.includes('connection') && errorLine.includes('refused')) || 
              errorLine.includes('timeout')) {
            console.error(`[backup-streaming] Detected error in stderr: ${line.trim()}`);
          }
        }
      });

      // Wait for process to complete
      await new Promise<void>((resolve, reject) => {
        childProcess.on('close', async (code) => {
          this.activeProcesses.delete(taskId);

          // Log completion
          await taskLoggerService.appendLog(taskId, 'stdout', `Backup process completed with exit code: ${code}`, stdoutLineCount + 1).catch(() => {});

          // Check if cancelled
          const currentTask = await this.getTask(taskId);
          if (currentTask?.status === 'cancelled') {
            await taskLoggerService.appendLog(taskId, 'stdout', 'Backup was cancelled', stdoutLineCount + 2).catch(() => {});
            try {
              await fs.unlink(filepath).catch(() => {});
            } catch {}
            return resolve();
          }

          if (code !== 0) {
            const errorMsg = `pg_dump exited with code ${code}. Check stderr logs for details.`;
            stderrLineCount++;
            await taskLoggerService.appendLog(taskId, 'stderr', errorMsg, stderrLineCount).catch(() => {});
            await this.updateTask(taskId, {
              status: 'failed',
              error_message: errorMsg,
            });
            return reject(new Error(errorMsg));
          }

          // Check if file was created
          const stats = await fs.stat(filepath);
          const fileSize = stats.size;
          
          await taskLoggerService.appendLog(taskId, 'stdout', `Backup file created: ${filename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`, stdoutLineCount + 2).catch(() => {});

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

      // Update file size periodically during execution and detect failures
      let lastFileSize = 0;
      let lastFileSizeTime = Date.now();
      let fileCreatedTime: number | null = null;
      const FILE_CREATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes to create file
      const FILE_STALL_TIMEOUT = 2 * 60 * 1000; // 2 minutes without growth = stalled
      const taskStartTime = startTime; // Capture start time for timeout checks
      
      const sizeCheckInterval = setInterval(async () => {
        try {
          const stats = await fs.stat(filepath);
          const currentSize = stats.size;
          const now = Date.now();
          
          if (!fileCreatedTime && currentSize > 0) {
            fileCreatedTime = now;
            stdoutLineCount++;
            await taskLoggerService.appendLog(taskId, 'stdout', `✓ Backup file created and growing: ${filepath} (${(currentSize / 1024).toFixed(2)} KB)`, stdoutLineCount).catch(() => {});
          }
          
          // Check if file is growing
          if (currentSize > lastFileSize) {
            lastFileSize = currentSize;
            lastFileSizeTime = now;
          } else if (currentSize > 0 && (now - lastFileSizeTime) > FILE_STALL_TIMEOUT) {
            // File exists but hasn't grown in 2 minutes
            const errorMsg = `Backup appears stalled: file size ${(currentSize / 1024 / 1024).toFixed(2)} MB hasn't changed in ${Math.round((now - lastFileSizeTime) / 1000 / 60)} minutes`;
            stderrLineCount++;
            await taskLoggerService.appendLog(taskId, 'stderr', errorMsg, stderrLineCount).catch(() => {});
            await this.updateTask(taskId, {
              status: 'stalled',
              error_message: errorMsg,
            });
          }
          
          await this.updateTask(taskId, {
            file_size: currentSize,
            metadata: {
              ...task.metadata,
              lastFileSizeUpdate: new Date().toISOString(),
            },
          });
        } catch (error: any) {
          // File doesn't exist yet - check if we've waited too long
          const now = Date.now();
          const timeSinceStart = now - taskStartTime;
          
          if (timeSinceStart > FILE_CREATION_TIMEOUT) {
            const errorMsg = `Backup file not created after ${Math.round(timeSinceStart / 1000 / 60)} minutes. Expected at: ${filepath}`;
            stderrLineCount++;
            await taskLoggerService.appendLog(taskId, 'stderr', errorMsg, stderrLineCount).catch(() => {});
            await taskLoggerService.appendLog(taskId, 'stderr', `Check if pg_dump process is running (PID: ${childProcess.pid})`, stderrLineCount + 1).catch(() => {});
            await taskLoggerService.appendLog(taskId, 'stderr', `Check logs at: ${stdoutPath} and ${stderrPath}`, stderrLineCount + 2).catch(() => {});
            
            // Check if process is still running
            try {
              process.kill(childProcess.pid || 0, 0); // Signal 0 just checks if process exists
            } catch {
              // Process doesn't exist - it crashed
              await this.updateTask(taskId, {
                status: 'failed',
                error_message: 'pg_dump process exited unexpectedly (file was never created)',
              });
            }
          }
        }
      }, 2000); // Check every 2 seconds

      // Clear interval when done
      childProcess.on('close', () => clearInterval(sizeCheckInterval));
      childProcess.on('error', () => clearInterval(sizeCheckInterval));

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

