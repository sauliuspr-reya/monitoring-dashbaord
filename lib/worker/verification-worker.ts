import { createSourceTargetPool } from '../db/connection';
import { VerificationService } from '../services/verification.service';
import { VerificationJob, BatchResult } from '../types/verification.types';
import { Pool } from 'pg';

/**
 * Data Integrity Verification Worker
 * Compares source and target tables row-by-row to detect mismatches and gaps
 * Optimized for high throughput (5000+ rows/sec)
 * 
 * Note: Environment variables are automatically loaded by Next.js from .env files
 * No need to import dotenv in Next.js applications
 */
export class VerificationWorker {
  private running = false;
  private service: VerificationService;
  private sourcePool: Pool | null = null;
  private targetPool: Pool | null = null;
  private currentJobId: number | null = null;
  private shutdownInProgress = false;

  constructor() {
    this.service = new VerificationService();
  }

  /**
   * Start the verification worker
   * Continuously checks for active jobs and processes them
   */
  async start(): Promise<void> {
    this.running = true;
    console.log('[verification-worker] Worker started');

    // Graceful shutdown handlers (register only once)
    const shutdownHandler = () => {
      if (!this.shutdownInProgress) {
        this.stop();
      } else {
        // Force exit on second Ctrl+C
        console.log('[verification-worker] Force stopping...');
        process.exit(0);
      }
    };
    
    process.once('SIGINT', shutdownHandler);
    process.once('SIGTERM', shutdownHandler);

    // Track state in memory (declared outside try for error handler access)
    let lastCheckedPk: string | null = null;
    let totalRowsChecked = BigInt(0);
    let totalMismatches = 0;
    let totalGaps = 0;
    let batchNumber = 0;
    let lastProgressUpdateTime = Date.now();
    const PROGRESS_UPDATE_INTERVAL_MS = 5000; // Update progress every 5 seconds

    while (this.running) {
      try {
        // Find active job (only one can run at a time)
        const job = await this.service.getRunningJob();

        if (!job) {
          // No active job, sleep and check again
          await this.sleep(5000);
          continue;
        }

        this.currentJobId = job.id;
        console.log(`[verification-worker] Processing job ${job.id} for table: ${job.table_name}`);
        console.log(`[verification-worker] Detected primary key: ${job.primary_key_column}`);
        console.log(`[verification-worker] Batch size: ${job.batch_size}, Cooldown: ${job.cooldown_ms}ms`);
        if (job.last_checked_pk_value) {
          console.log(`[verification-worker] Resuming from ${job.primary_key_column}=${job.last_checked_pk_value}`);
        }

        // Initialize database connections
        await this.initializePools();

        // Initialize state for this job
        let batchNumber = 0;
        lastCheckedPk = job.last_checked_pk_value;
        totalRowsChecked = BigInt(job.total_rows_checked);
        totalMismatches = job.mismatches_found;
        totalGaps = job.gaps_found;

        // Process batches until completed or stopped
        
        while (this.running) {
          batchNumber++;
          const startTime = Date.now();

          // Update job with current in-memory state
          job.last_checked_pk_value = lastCheckedPk;

          // Verify batch
          const result = await this.verifyBatch(job);

          // Update in-memory state (no DB writes!)
          if (result.lastPkValue) {
            lastCheckedPk = result.lastPkValue;
          }
          if (result.rowsChecked) {
            totalRowsChecked += BigInt(result.rowsChecked);
          }
          if (result.mismatchesFound) {
            totalMismatches += result.mismatchesFound;
          }
          if (result.gapsFound) {
            totalGaps += result.gapsFound;
          }

          const duration = Date.now() - startTime;
          const throughput = result.rowsChecked ? (result.rowsChecked / duration) * 1000 : 0;

          // Build log message with starting PK value
          const startPkInfo = result.startPkValue 
            ? ` starting from ${job.primary_key_column}=${result.startPkValue}` 
            : '';
          const mismatchInfo = result.mismatchesFound ? ` [${result.mismatchesFound} mismatches]` : '';
          const gapInfo = result.gapsFound ? ` [${result.gapsFound} gaps]` : '';

          console.log(
            `[verification-worker] Batch ${batchNumber}: ${result.rowsChecked} rows${startPkInfo} in ${duration}ms (${throughput.toFixed(0)} rows/sec)${mismatchInfo}${gapInfo}`
          );

          // Update progress every 5 seconds (fire-and-forget, non-blocking)
          const timeSinceLastUpdate = Date.now() - lastProgressUpdateTime;
          if (timeSinceLastUpdate >= PROGRESS_UPDATE_INTERVAL_MS) {
            this.service.updateJobState(job.id, {
              last_checked_pk_value: lastCheckedPk || '',
              total_rows_checked: totalRowsChecked,
              mismatches_found: totalMismatches,
              gaps_found: totalGaps,
            }).catch(err => {
              console.error('[verification-worker] Failed to update progress:', err.message);
            });
            lastProgressUpdateTime = Date.now();
          }

          if (result.completed) {
            // Save final state to DB on completion/stop
            await this.service.updateJobState(job.id, {
              last_checked_pk_value: lastCheckedPk || '',
              total_rows_checked: totalRowsChecked,
              mismatches_found: totalMismatches,
              gaps_found: totalGaps,
            });
            
            if (result.stoppedByUser) {
              console.log(`[verification-worker] Job ${job.id} stopped by user`);
            } else {
              console.log(`[verification-worker] Job ${job.id} completed successfully`);
            }
            break;
          }

          // Cooldown before next batch
          await this.sleep(job.cooldown_ms);

          // Check if user stopped during cooldown
          const currentJob = await this.service.getJobById(job.id);
          if (currentJob?.status === 'stopped') {
            // Save state to DB before stopping
            await this.service.updateJobState(job.id, {
              last_checked_pk_value: lastCheckedPk || '',
              total_rows_checked: totalRowsChecked,
              mismatches_found: totalMismatches,
              gaps_found: totalGaps,
            });
            console.log(`[verification-worker] Job ${job.id} stopped by user during cooldown`);
            break;
          }

          // Reload job to get updated config (in case user changed batch size/cooldown)
          const updatedJob = await this.service.getJobById(job.id);
          if (updatedJob) {
            job.batch_size = updatedJob.batch_size;
            job.cooldown_ms = updatedJob.cooldown_ms;
          }
        }

        // Cleanup connections
        await this.cleanupPools();
        this.currentJobId = null;

      } catch (error: any) {
        console.error('[verification-worker] Error:', error);
        
        if (this.currentJobId) {
          // Save state to DB before marking as error
          try {
            await this.service.updateJobState(this.currentJobId, {
              last_checked_pk_value: lastCheckedPk || '',
              total_rows_checked: totalRowsChecked,
              mismatches_found: totalMismatches,
              gaps_found: totalGaps,
            });
          } catch (stateError) {
            console.error('[verification-worker] Failed to save state:', stateError);
          }
          
          await this.service.markJobAsError(
            this.currentJobId,
            error.message || 'Unknown error'
          );
        }

        await this.cleanupPools();
        this.currentJobId = null;
        
        // Wait before retrying
        await this.sleep(5000);
      }
    }

    console.log('[verification-worker] Worker stopped');
  }

  /**
   * Stop the worker gracefully
   */
  async stop(): Promise<void> {
    if (this.shutdownInProgress) {
      return; // Already stopping
    }
    
    this.shutdownInProgress = true;
    console.log('[verification-worker] Stopping worker...');
    this.running = false;
    
    // Set a timeout to force exit if cleanup takes too long
    const forceExitTimeout = setTimeout(() => {
      console.log('[verification-worker] Force exit after timeout');
      process.exit(0);
    }, 5000); // 5 second timeout
    
    try {
      await this.cleanupPools();
      clearTimeout(forceExitTimeout);
    } catch (error) {
      console.error('[verification-worker] Error during cleanup:', error);
      clearTimeout(forceExitTimeout);
    }
  }

  /**
   * Initialize source and target database connection pools
   */
  private async initializePools(): Promise<void> {
    const sourceUrl = process.env.SOURCE_DATABASE_URL;
    const targetUrl = process.env.TARGET_DATABASE_URL;

    if (!sourceUrl || !targetUrl) {
      throw new Error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL must be configured');
    }

    this.sourcePool = createSourceTargetPool(sourceUrl);
    this.targetPool = createSourceTargetPool(targetUrl);
  }

  /**
   * Cleanup database connection pools
   */
  private async cleanupPools(): Promise<void> {
    const cleanupPromises = [];
    
    if (this.sourcePool) {
      cleanupPromises.push(
        this.sourcePool.end().catch((err) => {
          console.error('[verification-worker] Error closing source pool:', err.message);
        })
      );
      this.sourcePool = null;
    }
    
    if (this.targetPool) {
      cleanupPromises.push(
        this.targetPool.end().catch((err) => {
          console.error('[verification-worker] Error closing target pool:', err.message);
        })
      );
      this.targetPool = null;
    }
    
    // Wait for all cleanup with a timeout
    if (cleanupPromises.length > 0) {
      await Promise.race([
        Promise.all(cleanupPromises),
        new Promise(resolve => setTimeout(resolve, 2000)) // 2 second timeout
      ]);
    }
  }

  /**
   * Verify a single batch of rows
   * Core verification logic with hash-based comparison
   */
  private async verifyBatch(job: VerificationJob): Promise<BatchResult> {
    if (!this.sourcePool || !this.targetPool) {
      throw new Error('Database pools not initialized');
    }

    const {
      id: jobId,
      table_name,
      batch_size,
      primary_key_column,
      last_checked_pk_value,
      total_rows_checked,
      mismatches_found,
      gaps_found,
    } = job;

    // 1. Fetch batch from source
    const sourceRows = await this.service.fetchSourceBatch(
      this.sourcePool,
      table_name,
      primary_key_column,
      last_checked_pk_value,
      batch_size
    );

    if (sourceRows.length === 0) {
      // No more rows to check - mark as completed
      await this.service.completeJob(jobId);
      return { completed: true, rowsChecked: 0 };
    }

    // Track starting PK for logging
    const startPkValue = sourceRows[0].pk;

    // 2. Fetch corresponding rows from target
    const sourcePKs = sourceRows.map(r => r.pk);
    const targetRows = await this.service.fetchTargetRows(
      this.targetPool,
      table_name,
      primary_key_column,
      sourcePKs
    );

    // 3. Create target map for O(1) lookup
    const targetMap = new Map(targetRows.map(r => [String(r.pk), r]));

    // 4. Compare rows and collect mismatches/gaps
    const mismatchesToLog: Array<{
      jobId: number;
      tableName: string;
      pkValue: string;
      sourceRow: Record<string, any>;
      targetRow: Record<string, any>;
    }> = [];

    const gapsToLog: Array<{
      jobId: number;
      tableName: string;
      pkValue: string;
      sourceRow: Record<string, any>;
    }> = [];

    for (const sourceRow of sourceRows) {
      const pkValue = String(sourceRow.pk);
      const targetRow = targetMap.get(pkValue);

      if (!targetRow) {
        // GAP: Row exists in source but missing in target
        gapsToLog.push({
          jobId,
          tableName: table_name,
          pkValue,
          sourceRow: sourceRow.row_data,
        });
      } else if (sourceRow.row_hash !== targetRow.row_hash) {
        // MISMATCH: Row exists in both but data differs
        mismatchesToLog.push({
          jobId,
          tableName: table_name,
          pkValue,
          sourceRow: sourceRow.row_data,
          targetRow: targetRow.row_data,
        });
      }
      // else: MATCH - no action needed
    }

    // 5. Batch insert mismatches and gaps for performance
    if (mismatchesToLog.length > 0) {
      await this.service.logMismatchesBatch(mismatchesToLog);
    }

    if (gapsToLog.length > 0) {
      await this.service.logGapsBatch(gapsToLog);
    }

    // 6. Get last PK for in-memory state tracking (no DB write here!)
    const lastPK = sourceRows[sourceRows.length - 1].pk;

    // 7. Check if user stopped the job
    const currentJob = await this.service.getJobById(jobId);
    if (currentJob?.status === 'stopped') {
      return { 
        completed: true, 
        stoppedByUser: true, 
        rowsChecked: sourceRows.length,
        startPkValue: String(startPkValue),
        lastPkValue: String(lastPK),
        mismatchesFound: mismatchesToLog.length,
        gapsFound: gapsToLog.length
      };
    }

    return { 
      completed: false, 
      rowsChecked: sourceRows.length,
      startPkValue: String(startPkValue),
      lastPkValue: String(lastPK),
      mismatchesFound: mismatchesToLog.length,
      gapsFound: gapsToLog.length
    };
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run worker if executed directly
if (require.main === module) {
  const worker = new VerificationWorker();
  worker.start().catch(error => {
    console.error('[verification-worker] Fatal error:', error);
    process.exit(1);
  });
}
