import { getDbPool, createSourceTargetPool } from '../db/connection';
import { MonitoringService } from '../services/monitoring.service';
import { ConflictDetectionService } from '../services/conflict-detection.service';
import { AlertingService } from '../services/alerting.service';

const COLLECTION_INTERVAL = 30000; // 30 seconds

export class MetricsCollector {
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;

  async start() {
    if (this.isRunning) {
      console.log('Metrics collector already running');
      return;
    }

    console.log('Starting metrics collector...');
    this.isRunning = true;
    
    // Run immediately, then on interval
    await this.collectMetrics();
    
    this.intervalId = setInterval(() => {
      this.collectMetrics().catch((error) => {
        console.error('Error in metrics collection:', error);
      });
    }, COLLECTION_INTERVAL);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    console.log('Metrics collector stopped');
  }

  private async collectMetrics() {
    const pool = getDbPool();
    const monitoringService = new MonitoringService();
    const conflictService = new ConflictDetectionService();
    const alertingService = new AlertingService();

    try {
      // Get all enabled subscriptions
      const groupsResult = await pool.query(`
        SELECT * FROM subscriptions WHERE enabled = true
      `);

      for (const group of groupsResult.rows) {
        const sourcePool = createSourceTargetPool(group.source_db_connection);
        const targetPool = createSourceTargetPool(group.target_db_connection);

        try {
          // Collect replication status
          const status = await monitoringService.getReplicationStatus(
            sourcePool,
            targetPool,
            group.subscription_name,
            group.slot_name
          );

          // Save metrics
          await pool.query(`
            INSERT INTO replication_metrics (
              group_id, lag_bytes, lag_seconds, slot_lag_bytes,
              worker_pid, status, last_applied_lsn
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            group.id,
            status.lagBytes || 0,
            status.lagSeconds || 0,
            status.slotLagBytes || 0,
            status.workerPid || null,
            status.status || 'stopped',
            status.lastAppliedLsn || null,
          ]);

          // Detect conflicts
          const conflicts = await conflictService.detectConflicts(
            targetPool,
            group.subscription_name,
            group.id
          );

          // Save new conflicts
          for (const conflict of conflicts) {
            // Check if already exists
            const existing = await pool.query(`
              SELECT id FROM conflict_detections
              WHERE group_id = $1
                AND table_name = $2
                AND resolved_at IS NULL
                AND detected_at > NOW() - INTERVAL '1 hour'
            `, [conflict.groupId, conflict.tableName]);

            if (existing.rows.length === 0) {
              await conflictService.saveConflict(conflict);
            }
          }

          // Get tables in publication
          const tables = await monitoringService.getPublicationTables(
            sourcePool,
            group.publication_name
          );

          // Collect table-level metrics
          for (const tableFullName of tables) {
            const [schema, table] = tableFullName.replace(/"/g, '').split('.');
            const tableStatus = await monitoringService.getTableStatus(
              sourcePool,
              targetPool,
              table,
              schema
            );

            // Check for conflicts in this table
            const tableConflicts = conflicts.filter(
              (c) => c.tableName === table
            );
            const hasConflict = tableConflicts.length > 0;

            await pool.query(`
              INSERT INTO table_replication_metrics (
                group_id, table_name, source_row_count, target_row_count,
                gap_size, status
              ) VALUES ($1, $2, $3, $4, $5, $6)
            `, [
              group.id,
              table,
              tableStatus.sourceRowCount || 0,
              tableStatus.targetRowCount || 0,
              tableStatus.gapSize || 0,
              hasConflict ? 'conflict' : tableStatus.status || 'synced',
            ]);
          }

          // Check and create alerts
          await alertingService.checkAndAlert(
            group.id,
            group.name,
            {
              lagBytes: status.lagBytes || 0,
              lagSeconds: status.lagSeconds || 0,
              slotLagBytes: status.slotLagBytes || 0,
              status: status.status || 'stopped',
              hasConflict: conflicts.length > 0,
            }
          );
        } catch (error) {
          console.error(`Error collecting metrics for group ${group.name}:`, error);
          
          // Create alert for collection failure
          await alertingService.createAlert({
            groupId: group.id,
            alertType: 'connection_failure',
            message: `Failed to collect metrics: ${error instanceof Error ? error.message : 'Unknown error'}`,
            severity: 'error',
            acknowledged: false,
          });
        } finally {
          await sourcePool.end();
          await targetPool.end();
        }
      }
    } catch (error) {
      console.error('Error in metrics collection:', error);
    }
  }
}

// Run as standalone script
if (require.main === module) {
  const collector = new MetricsCollector();
  collector.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    collector.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    collector.stop();
    process.exit(0);
  });
}

