import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { BackupTaskService, BackupTask } from './backup-task.service';
import { taskLoggerService } from './task-logger.service';
import { createSourceTargetPool } from '@/lib/db/connection';

type TableIdentifier = { schema: string; table: string };

const stripQuotes = (value: string) => value.replace(/^"|"$/g, '');

const parseTableIdentifier = (identifier: string): TableIdentifier => {
  const trimmed = identifier.trim();
  if (trimmed.includes('.')) {
    const [schemaPart, tablePart] = trimmed.split('.', 2);
    return {
      schema: stripQuotes(schemaPart) || 'public',
      table: stripQuotes(tablePart),
    };
  }
  return { schema: 'public', table: stripQuotes(trimmed) };
};

const quoteIdentifier = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const formatTableForSql = (identifier: string) => {
  const { schema, table } = parseTableIdentifier(identifier);
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
};

const buildQualifiedName = (schema: string, table: string) =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

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

    // Database client for transaction (if needed)
    let dbClient: any = null;
    let dbPool: any = null;

    try {
      const backupDir = await this.getBackupDir();
      await fs.mkdir(backupDir, { recursive: true });

      const conn = this.parseConnectionString(connectionString);

      // Use custom filename if provided, otherwise generate with timestamp
      let filename: string;
      if (task.filename && task.filename.trim()) {
        // Custom name provided - use it
        filename = `${task.filename}.sql`;
      } else {
        // Generate filename using timestamp and task ID
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        filename = `backup_${timestamp}_${taskId.substring(0, 8)}.sql`;
      }
      const filepath = path.join(backupDir, filename);

      await this.updateTask(taskId, {
        filename,
        filepath,
      });

      // Check if we need to create a slot/snapshot (consistent backup)
      const createSlot = task.metadata?.createSlot === true;
      let snapshotId = task.snapshot_id;
      let slotName = task.slot_name;
      let publicationName = task.publication_name;
      let slotInitialLsn = task.slot_initial_lsn;

      // If createSlot is requested, we need to:
      // 1. Connect to DB
      // 2. Start transaction
      // 3. Create slot (if needed)
      // 4. Export snapshot
      // 5. Keep transaction open while pg_dump runs
      if (createSlot) {
        stdoutLineCount++;
        await taskLoggerService.appendLog(taskId, 'stdout', 'Initializing consistent backup with replication slot...', stdoutLineCount);

        // Use imported createSourceTargetPool
        dbPool = createSourceTargetPool(connectionString);
        dbClient = await dbPool.connect();

        // Check if we are on a Read Replica
        const recoveryResult = await dbClient.query('SELECT pg_is_in_recovery()');
        const isReplica = recoveryResult.rows[0]?.pg_is_in_recovery === true;

        if (isReplica) {
          throw new Error(
            'Cannot create a consistent backup with replication slot from a Read Replica. ' +
            'Logical replication slots must be created on the Primary database. ' +
            'Please update SOURCE_DATABASE_URL to point to the Primary instance.'
          );
        }

        // Generate names if not provided
        if (!slotName) slotName = `backup_slot_${Date.now()}`;
        if (!publicationName) publicationName = `backup_pub_${Date.now()}`;

        // 1. Create Publication (if not exists)
        // We create publication BEFORE starting the transaction because creating a publication
        // involves writes to system catalogs, and we cannot create a replication slot
        // in a transaction that has already performed writes.
        try {
          const checkPub = await dbClient.query('SELECT 1 FROM pg_publication WHERE pubname = $1', [publicationName]);
          if (checkPub.rows.length === 0) {
            const escapedPubName = `"${publicationName.replace(/"/g, '""')}"`;

            // Determine tables for publication
            if (task.exclude_tables && task.exclude_tables.length > 0) {
              await dbClient.query(`CREATE PUBLICATION ${escapedPubName} FOR ALL TABLES`);
            } else if (task.tables && task.tables.length > 0) {
              const tableList = task.tables.map((t: string) => {
                const escaped = t.replace(/"/g, '""');
                return `"${escaped}"`;
              }).join(', ');
              await dbClient.query(`CREATE PUBLICATION ${escapedPubName} FOR TABLE ${tableList}`);
            } else {
              await dbClient.query(`CREATE PUBLICATION ${escapedPubName} FOR ALL TABLES`);
            }
            stdoutLineCount++;
            await taskLoggerService.appendLog(taskId, 'stdout', `Created publication: ${publicationName}`, stdoutLineCount);
          } else {
            stdoutLineCount++;
            await taskLoggerService.appendLog(taskId, 'stdout', `Using existing publication: ${publicationName}`, stdoutLineCount);
          }
        } catch (err: any) {
          stdoutLineCount++;
          await taskLoggerService.appendLog(taskId, 'stdout', `Warning creating publication: ${err.message}`, stdoutLineCount);
        }

        // Start transaction
        await dbClient.query('BEGIN');

        // 2. Create Replication Slot
        // Check if exists first
        const checkSlot = await dbClient.query('SELECT 1 FROM pg_replication_slots WHERE slot_name = $1', [slotName]);
        if (checkSlot.rows.length === 0) {
          await dbClient.query("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", [slotName]);
          stdoutLineCount++;
          await taskLoggerService.appendLog(taskId, 'stdout', `Created replication slot: ${slotName}`, stdoutLineCount);
        } else {
          stdoutLineCount++;
          await taskLoggerService.appendLog(taskId, 'stdout', `Using existing replication slot: ${slotName}`, stdoutLineCount);
        }

        // 3. Get Slot LSN (for info)
        const lsnResult = await dbClient.query(`
          SELECT confirmed_flush_lsn, pg_current_wal_lsn() 
          FROM pg_replication_slots WHERE slot_name = $1
        `, [slotName]);
        slotInitialLsn = lsnResult.rows[0]?.confirmed_flush_lsn || lsnResult.rows[0]?.pg_current_wal_lsn;

        // 4. Export Snapshot
        const snapshotResult = await dbClient.query('SELECT pg_export_snapshot()');
        snapshotId = snapshotResult.rows[0]?.pg_export_snapshot;

        stdoutLineCount++;
        await taskLoggerService.appendLog(taskId, 'stdout', `Exported snapshot: ${snapshotId}`, stdoutLineCount);
        stdoutLineCount++;
        await taskLoggerService.appendLog(taskId, 'stdout', `Initial LSN: ${slotInitialLsn}`, stdoutLineCount);

        // Update task with generated info
        await this.updateTask(taskId, {
          snapshot_id: snapshotId,
          slot_name: slotName,
          publication_name: publicationName,
          slot_initial_lsn: slotInitialLsn,
          metadata: {
            ...task.metadata,
            generatedSnapshot: true
          }
        });
      }

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

      // CRITICAL: Add snapshot ID if available
      if (snapshotId) {
        args.push(`--snapshot=${snapshotId}`);
      }

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
      await taskLoggerService.appendLog(taskId, 'stdout', `Executing: ${shellCommand.replace(/PGPASSWORD='[^']+'/, "PGPASSWORD='***'")}`, stdoutLineCount).catch(() => { });

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
      await taskLoggerService.appendLog(taskId, 'stdout', `Backup directory: ${backupDir}`, stdoutLineCount).catch(() => { });
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Full file path: ${filepath}`, stdoutLineCount).catch(() => { });
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Log files (persistent): ${stdoutPath}, ${stderrPath}`, stdoutLineCount).catch(() => { });
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Tables: ${task.tables?.length || 0}, Excluded: ${task.exclude_tables?.length || 0}`, stdoutLineCount).catch(() => { });
      stdoutLineCount++;
      await taskLoggerService.appendLog(taskId, 'stdout', `Command: pg_dump ${args.join(' ').replace(/PGPASSWORD=[^\s]+/g, 'PGPASSWORD=***')}`, stdoutLineCount).catch(() => { });

      // Initialize variables for file size tracking and stall detection
      // These need to be declared before the event handlers that use them
      let lastFileSize = 0;
      let lastFileSizeTime = Date.now();
      let lastStderrActivityTime = Date.now();
      let fileCreatedTime: number | null = null;
      const FILE_CREATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes to create file
      const FILE_STALL_TIMEOUT = 15 * 60 * 1000; // 15 minutes without growth = stalled (for large tables)
      const taskStartTime = startTime; // Capture start time for timeout checks

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
        // Update stderr activity time - this indicates the process is making progress
        lastStderrActivityTime = Date.now();

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

      // Flag to track if process has completed (to prevent interval from interfering)
      let processCompleted = false;
      let processExited = false;

      // Update file size periodically during execution and detect failures
      const sizeCheckInterval = setInterval(async () => {
        // Don't check if process has already completed
        if (processCompleted || processExited) {
          clearInterval(sizeCheckInterval);
          return;
        }

        try {
          const stats = await fs.stat(filepath);
          const currentSize = stats.size;
          const now = Date.now();

          if (!fileCreatedTime && currentSize > 0) {
            fileCreatedTime = now;
            stdoutLineCount++;
            await taskLoggerService.appendLog(taskId, 'stdout', `✓ Backup file created and growing: ${filepath} (${(currentSize / 1024).toFixed(2)} KB)`, stdoutLineCount).catch(() => { });
          }

          // Check if file is growing
          if (currentSize > lastFileSize) {
            lastFileSize = currentSize;
            lastFileSizeTime = now;
          } else if (currentSize > 0 && (now - lastFileSizeTime) > FILE_STALL_TIMEOUT) {
            // File hasn't grown in a while - check if process is still running and if stderr is active
            let processRunning = false;
            try {
              // Check if the shell process is still running
              process.kill(childProcess.pid || 0, 0); // Signal 0 just checks if process exists
              processRunning = true;
            } catch {
              // Process doesn't exist
              processRunning = false;
            }

            // Check if stderr has been active recently (within last 5 minutes)
            const stderrActiveRecently = (now - lastStderrActivityTime) < 5 * 60 * 1000;

            if (!processRunning) {
              // Process is not running AND file hasn't grown
              // Check if task is already completed/failed/cancelled before marking as stalled
              const currentTask = await this.getTask(taskId);
              if (currentTask && (currentTask.status === 'completed' || currentTask.status === 'failed' || currentTask.status === 'cancelled')) {
                // Task already completed - don't mark as stalled, just stop checking
                clearInterval(sizeCheckInterval);
                return;
              }

              // Process exited but task not marked as completed - might be stalled or just finished
              // Give it a small grace period (30 seconds) for the close handler to process
              const timeSinceLastGrowth = now - lastFileSizeTime;
              if (timeSinceLastGrowth > 30 * 1000) {
                // More than 30 seconds since last growth and process not running
                // Check if process just exited (give close handler time to run)
                const timeSinceProcessExit = now - (lastStderrActivityTime || taskStartTime);
                if (timeSinceProcessExit < 60 * 1000) {
                  // Process exited recently (within last minute) - might be completing, wait a bit more
                  return;
                }

                // Process has been gone for a while and file hasn't grown - likely stalled
                const errorMsg = `Backup appears stalled: file size ${(currentSize / 1024 / 1024).toFixed(2)} MB hasn't changed in ${Math.round((now - lastFileSizeTime) / 1000 / 60)} minutes and process is not running`;
                stderrLineCount++;
                await taskLoggerService.appendLog(taskId, 'stderr', errorMsg, stderrLineCount).catch(() => { });
                await this.updateTask(taskId, {
                  status: 'stalled',
                  error_message: errorMsg,
                });
              }
            } else if (!stderrActiveRecently) {
              // Process is running but no stderr activity - might be stuck
              const minutesSinceStderr = Math.round((now - lastStderrActivityTime) / 1000 / 60);
              const minutesSinceGrowth = Math.round((now - lastFileSizeTime) / 1000 / 60);
              if (minutesSinceStderr > 10) {
                // No stderr activity for 10+ minutes - likely stalled
                const errorMsg = `Backup appears stalled: file size ${(currentSize / 1024 / 1024).toFixed(2)} MB hasn't changed in ${minutesSinceGrowth} minutes, no stderr output for ${minutesSinceStderr} minutes (process may be stuck)`;
                stderrLineCount++;
                await taskLoggerService.appendLog(taskId, 'stderr', errorMsg, stderrLineCount).catch(() => { });
                await this.updateTask(taskId, {
                  status: 'stalled',
                  error_message: errorMsg,
                });
              }
            } else {
              // Process is running AND stderr is active - just processing a large table, don't mark as stalled
              const minutesSinceGrowth = Math.round((now - lastFileSizeTime) / 1000 / 60);
              if (minutesSinceGrowth % 5 === 0 && minutesSinceGrowth > 0) {
                // Log every 5 minutes to avoid spam
                stdoutLineCount++;
                await taskLoggerService.appendLog(taskId, 'stdout', `ℹ File size hasn't changed in ${minutesSinceGrowth} minutes, but process is running and producing output (processing large table)`, stdoutLineCount).catch(() => { });
              }
            }
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
          // But don't check if process has already exited (it might be completing)
          if (processExited) {
            return;
          }

          const now = Date.now();
          const timeSinceStart = now - taskStartTime;

          if (timeSinceStart > FILE_CREATION_TIMEOUT) {
            const errorMsg = `Backup file not created after ${Math.round(timeSinceStart / 1000 / 60)} minutes. Expected at: ${filepath}`;
            stderrLineCount++;
            await taskLoggerService.appendLog(taskId, 'stderr', errorMsg, stderrLineCount).catch(() => { });
            await taskLoggerService.appendLog(taskId, 'stderr', `Check if pg_dump process is running (PID: ${childProcess.pid})`, stderrLineCount + 1).catch(() => { });
            await taskLoggerService.appendLog(taskId, 'stderr', `Check logs at: ${stdoutPath} and ${stderrPath}`, stderrLineCount + 2).catch(() => { });

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

      // Wait for process to complete
      await new Promise<void>((resolve, reject) => {
        childProcess.on('close', async (code) => {
          processExited = true;
          this.activeProcesses.delete(taskId);

          // Clear the size check interval immediately to prevent interference
          clearInterval(sizeCheckInterval);

          // Small delay to ensure file is fully written
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Log completion
          stdoutLineCount++;
          await taskLoggerService.appendLog(taskId, 'stdout', `Backup process completed with exit code: ${code}`, stdoutLineCount).catch(() => { });

          // Check if cancelled
          const currentTask = await this.getTask(taskId);
          if (currentTask?.status === 'cancelled') {
            stdoutLineCount++;
            await taskLoggerService.appendLog(taskId, 'stdout', 'Backup was cancelled', stdoutLineCount).catch(() => { });
            try {
              await fs.unlink(filepath).catch(() => { });
            } catch { }

            // Rollback transaction if active
            if (dbClient) {
              try { await dbClient.query('ROLLBACK'); } catch { }
            }

            processCompleted = true;
            return resolve();
          }

          if (code !== 0) {
            const errorMsg = `pg_dump exited with code ${code}. Check stderr logs for details.`;
            stderrLineCount++;
            await taskLoggerService.appendLog(taskId, 'stderr', errorMsg, stderrLineCount).catch(() => { });
            await this.updateTask(taskId, {
              status: 'failed',
              error_message: errorMsg,
            });

            // Rollback transaction if active
            if (dbClient) {
              try { await dbClient.query('ROLLBACK'); } catch { }
            }

            processCompleted = true;
            return reject(new Error(errorMsg));
          }

          // Exit code is 0 - backup completed successfully
          try {
            // Check if file was created
            const stats = await fs.stat(filepath);
            const fileSize = stats.size;

            stdoutLineCount++;
            await taskLoggerService.appendLog(taskId, 'stdout', `✓ Backup completed successfully: ${filename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`, stdoutLineCount).catch(() => { });

            // Commit transaction if active
            if (dbClient) {
              stdoutLineCount++;
              await taskLoggerService.appendLog(taskId, 'stdout', 'Committing transaction...', stdoutLineCount);
              await dbClient.query('COMMIT');
              stdoutLineCount++;
              await taskLoggerService.appendLog(taskId, 'stdout', 'Transaction committed successfully', stdoutLineCount);
            }

            await this.updateTask(taskId, {
              status: 'completed',
              filename,
              filepath,
              file_size: fileSize,
              metadata: {
                ...task.metadata,
                stdout_lines: stdoutLineCount,
                stderr_lines: stderrLineCount,
                process_pid: undefined, // Clear PID since process is done
              },
            });

            processCompleted = true;
            resolve();
          } catch (fileError: any) {
            // File doesn't exist or can't be read
            const errorMsg = `Backup completed with exit code 0, but file not found: ${filepath}`;
            stderrLineCount++;
            await taskLoggerService.appendLog(taskId, 'stderr', errorMsg, stderrLineCount).catch(() => { });
            await this.updateTask(taskId, {
              status: 'failed',
              error_message: errorMsg,
            });

            // Rollback transaction if active
            if (dbClient) {
              try { await dbClient.query('ROLLBACK'); } catch { }
            }

            processCompleted = true;
            reject(new Error(errorMsg));
          }
        });

        childProcess.on('error', async (error) => {
          processExited = true;
          this.activeProcesses.delete(taskId);
          clearInterval(sizeCheckInterval);
          await this.updateTask(taskId, {
            status: 'failed',
            error_message: error.message,
          });

          // Rollback transaction if active
          if (dbClient) {
            try { await dbClient.query('ROLLBACK'); } catch { }
          }

          processCompleted = true;
          reject(error);
        });
      });

    } catch (error: any) {
      this.activeProcesses.delete(taskId);

      // Rollback transaction if active
      if (dbClient) {
        try { await dbClient.query('ROLLBACK'); } catch { }
      }

      const currentTask = await this.getTask(taskId);
      if (currentTask?.status === 'cancelled') {
        return;
      }

      await this.updateTask(taskId, {
        status: 'failed',
        error_message: error.message || 'Unknown error',
      });
      throw error;
    } finally {
      // Release database client
      if (dbClient) {
        try {
          dbClient.release();
        } catch (e) {
          console.error('Error releasing database client:', e);
        }
      }
      if (dbPool) {
        try {
          await dbPool.end();
        } catch (e) {
          // Ignore pool end errors
        }
      }
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
    let encounteredError = false;
    let firstErrorLine: string | null = null;

    try {
      const conn = this.parseConnectionString(connectionString);
      await fs.access(task.filepath);

      const isCustomFormat = task.filepath.endsWith('.dump') || task.filepath.endsWith('.backup');
      const isCompressed = task.filepath.endsWith('.gz');

      let childProcess: ChildProcess;

      // Check if clean restore is requested (from metadata)
      const cleanRestore = task.metadata?.cleanRestore === true;
      // Check if specific tables should be restored (from metadata)
      const restoreTables = task.metadata?.restoreTables as string[] | undefined;

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
        ];

        // Add --clean and --if-exists for clean restore
        if (cleanRestore) {
          args.push('--clean', '--if-exists');
        }

        // Add table selection if specific tables are requested
        if (restoreTables && restoreTables.length > 0) {
          for (const table of restoreTables) {
            // pg_restore uses -t for table selection
            // Format: schema.table or just table (assumes public schema)
            args.push('-t', table);
          }
          stdoutLineCount++;
          await taskLoggerService.appendLog(taskId, 'stdout', `Restoring ${restoreTables.length} selected table(s): ${restoreTables.join(', ')}`, stdoutLineCount).catch(() => { });
        }

        args.push(task.filepath);

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
          // For plain SQL, we need to handle clean restore differently
          // If clean restore is requested, we'll DROP all objects (tables, functions, triggers, etc.) before restore
          // This ensures a completely clean restore with no conflicts
          if (cleanRestore) {
            // First, get list of tables and other objects from the backup file
            // We'll extract object names and drop them before restore
            stdoutLineCount++;
            await taskLoggerService.appendLog(taskId, 'stdout', 'Clean restore requested: will DROP all objects before restore', stdoutLineCount).catch(() => { });

            // Extract table names from backup file (look for CREATE TABLE and COPY statements)
            // For very large files, we'll read in chunks to avoid memory issues
            try {
              let backupContent: string;
              const fileStats = await fs.stat(task.filepath);
              const fileSizeMB = fileStats.size / (1024 * 1024);

              // For files larger than 500MB, read only the first 100MB (should contain all CREATE TABLE statements)
              if (fileSizeMB > 500) {
                stdoutLineCount++;
                await taskLoggerService.appendLog(taskId, 'stdout', `Large backup file (${fileSizeMB.toFixed(1)} MB), reading header for table extraction...`, stdoutLineCount).catch(() => { });
                const fileHandle = await fs.open(task.filepath, 'r');
                const buffer = Buffer.alloc(100 * 1024 * 1024); // Read first 100MB
                await fileHandle.read(buffer, 0, buffer.length, 0);
                await fileHandle.close();
                backupContent = buffer.toString('utf-8');
              } else {
                backupContent = await fs.readFile(task.filepath, 'utf-8');
              }

              // Extract all objects that need to be dropped
              // 1. Tables (from CREATE TABLE and COPY statements)
              const createTableMatches = backupContent.match(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?([^\s(]+)/gim) || [];
              const copyMatches = backupContent.match(/^COPY\s+(?:public\.)?([^\s(]+)/gm) || [];

              // 2. Functions (from CREATE FUNCTION statements)
              const functionMatches = backupContent.match(/^CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+(?:public\.)?([^\s(]+)/gim) || [];

              // 3. Triggers (from CREATE TRIGGER statements)
              const triggerMatches = backupContent.match(/^CREATE\s+(?:OR REPLACE\s+)?TRIGGER\s+([^\s]+)/gim) || [];

              // Extract and deduplicate table names
              const allTableMatches = [...createTableMatches, ...copyMatches];
              const tables = [...new Set(allTableMatches.map(m => {
                let tableName = m.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?/i, '')
                  .replace(/^COPY\s+(?:public\.)?/i, '')
                  .replace(/"/g, '')
                  .trim();
                if (tableName.includes('.')) {
                  tableName = tableName.split('.').pop() || tableName;
                }
                return tableName;
              }))];

              // Extract function names
              const functions = [...new Set(functionMatches.map(m => {
                let funcName = m.replace(/^CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+(?:public\.)?/i, '')
                  .replace(/\(.*$/, '') // Remove parameters
                  .replace(/"/g, '')
                  .trim();
                if (funcName.includes('.')) {
                  funcName = funcName.split('.').pop() || funcName;
                }
                return funcName;
              }))];

              // Extract trigger names
              const triggers = [...new Set(triggerMatches.map(m => {
                return m.replace(/^CREATE\s+(?:OR REPLACE\s+)?TRIGGER\s+/i, '')
                  .replace(/\s+ON.*$/i, '') // Remove ON table part
                  .replace(/"/g, '')
                  .trim();
              }))];

              if (tables.length > 0 || functions.length > 0 || triggers.length > 0) {
                stdoutLineCount++;
                await taskLoggerService.appendLog(taskId, 'stdout',
                  `Found ${tables.length} tables, ${functions.length} functions, ${triggers.length} triggers to drop`,
                  stdoutLineCount).catch(() => { });

                // Build DROP commands
                // Drop in reverse dependency order: triggers -> functions -> tables
                const dropCommands: string[] = [];

                // Drop triggers first (they depend on tables)
                // We need to drop triggers per table, so we'll drop all triggers on each table
                // Extract trigger-table pairs from backup content
                const triggerTablePairs: Array<{ trigger: string, table: string }> = [];
                for (const triggerMatch of triggerMatches) {
                  // Extract trigger name and table name from CREATE TRIGGER ... ON table
                  const triggerTableMatch = triggerMatch.match(/CREATE\s+(?:OR REPLACE\s+)?TRIGGER\s+([^\s]+)\s+.*?\s+ON\s+(?:public\.)?([^\s(]+)/i);
                  if (triggerTableMatch) {
                    const triggerName = triggerTableMatch[1].replace(/"/g, '').trim();
                    let tableName = triggerTableMatch[2].replace(/"/g, '').trim();
                    if (tableName.includes('.')) {
                      tableName = tableName.split('.').pop() || tableName;
                    }
                    triggerTablePairs.push({ trigger: triggerName, table: tableName });
                  }
                }

                // Drop each trigger on its specific table
                for (const { trigger, table } of triggerTablePairs) {
                  const cleanTrigger = trigger.replace(/^"|"$/g, '');
                  const cleanTable = table.replace(/^"|"$/g, '');
                  const quotedTrigger = (cleanTrigger !== cleanTrigger.toLowerCase() || /[^a-z0-9_]/.test(cleanTrigger))
                    ? `"${cleanTrigger.replace(/"/g, '""')}"`
                    : cleanTrigger;
                  const quotedTable = (cleanTable !== cleanTable.toLowerCase() || /[^a-z0-9_]/.test(cleanTable))
                    ? `"${cleanTable.replace(/"/g, '""')}"`
                    : cleanTable;
                  dropCommands.push(`DROP TRIGGER IF EXISTS ${quotedTrigger} ON public.${quotedTable} CASCADE;`);
                }

                // Also drop any remaining triggers that weren't matched (fallback)
                const matchedTriggers = new Set(triggerTablePairs.map(tp => tp.trigger));
                for (const trigger of triggers) {
                  if (!matchedTriggers.has(trigger)) {
                    // Try to drop on all tables (less efficient but safer)
                    for (const table of tables) {
                      const cleanTrigger = trigger.replace(/^"|"$/g, '');
                      const cleanTable = table.replace(/^"|"$/g, '');
                      const quotedTrigger = (cleanTrigger !== cleanTrigger.toLowerCase() || /[^a-z0-9_]/.test(cleanTrigger))
                        ? `"${cleanTrigger.replace(/"/g, '""')}"`
                        : cleanTrigger;
                      const quotedTable = (cleanTable !== cleanTable.toLowerCase() || /[^a-z0-9_]/.test(cleanTable))
                        ? `"${cleanTable.replace(/"/g, '""')}"`
                        : cleanTable;
                      dropCommands.push(`DROP TRIGGER IF EXISTS ${quotedTrigger} ON public.${quotedTable} CASCADE;`);
                    }
                  }
                }

                // Drop functions (they may be used by triggers)
                for (const func of functions) {
                  const cleanFunc = func.replace(/^"|"$/g, '');
                  const quotedFunc = (cleanFunc !== cleanFunc.toLowerCase() || /[^a-z0-9_]/.test(cleanFunc))
                    ? `"${cleanFunc.replace(/"/g, '""')}"`
                    : cleanFunc;
                  // Drop function with all overloads
                  dropCommands.push(`DROP FUNCTION IF EXISTS public.${quotedFunc} CASCADE;`);
                }

                // Drop tables last (they depend on nothing, but everything depends on them)
                for (const table of tables) {
                  const cleanTable = table.replace(/^"|"$/g, '');
                  const quotedTable = (cleanTable !== cleanTable.toLowerCase() || /[^a-z0-9_]/.test(cleanTable))
                    ? `"${cleanTable.replace(/"/g, '""')}"`
                    : cleanTable;
                  // DROP CASCADE will also drop indexes, constraints, sequences, etc.
                  dropCommands.push(`DROP TABLE IF EXISTS public.${quotedTable} CASCADE;`);
                }

                const allDropCommands = dropCommands.join('\n');

                // Execute drop via psql
                // Use -f - to read from stdin for large command strings
                const dropArgs = [
                  '-h', conn.host,
                  '-p', conn.port.toString(),
                  '-U', conn.user,
                  '-d', conn.database,
                ];

                // For very large command strings, use stdin instead of -c
                const useStdin = allDropCommands.length > 100000; // ~100KB limit for -c

                if (!useStdin) {
                  // Add -c flag for smaller command strings
                  dropArgs.push('-c', allDropCommands);
                } else {
                  // Use -f - to read from stdin
                  dropArgs.push('-f', '-');
                }

                stdoutLineCount++;
                await taskLoggerService.appendLog(taskId, 'stdout',
                  `Dropping ${triggers.length} triggers, ${functions.length} functions, ${tables.length} tables...`,
                  stdoutLineCount).catch(() => { });

                const dropProcess = spawn('psql', dropArgs, {
                  env: {
                    ...process.env,
                    PGPASSWORD: conn.password,
                  },
                  stdio: useStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
                });

                // If using stdin, write the commands
                if (useStdin && dropProcess.stdin) {
                  dropProcess.stdin.write(allDropCommands);
                  dropProcess.stdin.end();
                }

                // Capture drop output
                dropProcess.stdout?.on('data', async (data: Buffer) => {
                  const lines = data.toString('utf-8').split('\n').filter(l => l.length > 0);
                  for (const line of lines) {
                    stdoutLineCount++;
                    await taskLoggerService.appendLog(taskId, 'stdout', `[DROP] ${line}`, stdoutLineCount).catch(() => { });
                  }
                });

                dropProcess.stderr?.on('data', async (data: Buffer) => {
                  const lines = data.toString('utf-8').split('\n').filter(l => l.length > 0);
                  for (const line of lines) {
                    stderrLineCount++;
                    await taskLoggerService.appendLog(taskId, 'stderr', `[DROP] ${line}`, stderrLineCount).catch(() => { });
                  }
                });

                // Wait for drop to complete
                await new Promise<void>((resolve, reject) => {
                  dropProcess.on('close', (code) => {
                    if (code === 0) {
                      stdoutLineCount++;
                      taskLoggerService.appendLog(taskId, 'stdout', '✓ All objects dropped successfully', stdoutLineCount).catch(() => { });
                      resolve();
                    } else {
                      stderrLineCount++;
                      taskLoggerService.appendLog(taskId, 'stderr', `⚠ Drop completed with code ${code} (continuing with restore)`, stderrLineCount).catch(() => { });
                      resolve(); // Continue anyway - some objects might not exist
                    }
                  });
                  dropProcess.on('error', (err) => {
                    stderrLineCount++;
                    taskLoggerService.appendLog(taskId, 'stderr', `⚠ Drop error: ${err.message} (continuing with restore)`, stderrLineCount).catch(() => { });
                    resolve(); // Continue anyway
                  });
                });
              }
            } catch (error: any) {
              stderrLineCount++;
              await taskLoggerService.appendLog(taskId, 'stderr', `⚠ Could not extract object names for drop: ${error.message} (continuing with restore)`, stderrLineCount).catch(() => { });
            }
          }

          // After dropping all objects, restore normally (no need for ON_ERROR_STOP=off since everything is dropped)
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

          const trimmed = line.trim();
          const lower = trimmed.toLowerCase();
          if (
            lower.startsWith('error:') ||
            lower.startsWith('fatal:') ||
            lower.includes('duplicate key value violates unique constraint') ||
            lower.includes('does not exist') ||
            lower.includes('violates foreign key constraint')
          ) {
            encounteredError = true;
            if (!firstErrorLine) {
              firstErrorLine = trimmed;
            }
          }
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

          if (code !== 0 || encounteredError) {
            const errorMsg = code !== 0
              ? `Restore exited with code ${code}`
              : `Restore completed with exit code 0, but errors were detected: ${firstErrorLine || 'see logs'}`;

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

