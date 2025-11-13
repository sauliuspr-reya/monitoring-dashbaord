#!/usr/bin/env ts-node

/**
 * Rate of Change Collector Worker
 * 
 * This worker runs periodically to:
 * 1. Query row counts from source (and optionally target) databases
 * 2. Calculate rate of change based on historical data
 * 3. Store the data for time series analysis and plotting
 * 
 * Run this as a cron job or systemd timer:
 * - Every 1 minute for high-frequency monitoring
 * - Every 5-10 minutes for normal monitoring
 * 
 * Example cron (every 5 minutes):
 * Add to crontab: (star)/5 (star) (star) (star) (star) cd /path/to/dashboard && ts-node lib/worker/rate-of-change-collector.ts
 */

import { RateOfChangeService } from '../services/rate-of-change.service';
import { getDbPool } from '../db/connection';

class RateOfChangeCollector {
  private service: RateOfChangeService;
  private intervalMinutes: number;
  private intervalId?: NodeJS.Timeout;

  constructor(intervalMinutes: number = 10) {
    this.service = new RateOfChangeService();
    this.intervalMinutes = intervalMinutes;
  }

  /**
   * Start the collector as a continuous process
   */
  start(): void {
    console.log(`Starting rate of change collector (interval: ${this.intervalMinutes} minutes)`);
    
    // Run immediately
    this.collect();

    // Then run on interval
    this.intervalId = setInterval(
      () => this.collect(),
      this.intervalMinutes * 60 * 1000
    );

    // Handle graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * Stop the collector
   */
  stop(): void {
    console.log('Stopping rate of change collector...');
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    process.exit(0);
  }

  /**
   * Run a single collection cycle
   */
  async collect(): Promise<void> {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Starting rate of change collection...`);

    try {
      // Get all subscriptions from monitoring database
      const monitoringPool = getDbPool();
      const subscriptionsResult = await monitoringPool.query(`
        SELECT 
          id,
          name,
          source_db_connection,
          target_db_connection,
          enabled
        FROM subscriptions
        WHERE enabled = true
      `);

      const subscriptions = subscriptionsResult.rows;
      console.log(`Found ${subscriptions.length} active subscriptions`);

      if (subscriptions.length === 0) {
        console.log('No active subscriptions found. Checking source database from env...');
        
        // Fallback to environment variables if no subscriptions configured
        const sourceUrl = process.env.SOURCE_DATABASE_URL;
        const targetUrl = process.env.TARGET_DATABASE_URL;
        
        if (sourceUrl) {
          console.log('Using source database from environment variables');
          await this.service.calculateAndStoreRateOfChange(sourceUrl, targetUrl);
        } else {
          console.log('No source database configured. Skipping collection.');
        }
      } else {
        // Process each subscription
        // Group by unique source connection to avoid duplicate work
        const uniqueSources = new Map<string, { source: string; target?: string }>();
        
        for (const sub of subscriptions) {
          if (!uniqueSources.has(sub.source_db_connection)) {
            uniqueSources.set(sub.source_db_connection, {
              source: sub.source_db_connection,
              target: sub.target_db_connection,
            });
          }
        }

        console.log(`Processing ${uniqueSources.size} unique database pairs...`);
        
        for (const [_, config] of uniqueSources) {
          try {
            await this.service.calculateAndStoreRateOfChange(
              config.source,
              config.target
            );
          } catch (error) {
            console.error('Error processing database pair:', error);
            // Continue with other databases
          }
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[${new Date().toISOString()}] Collection completed in ${duration}s`);

      // Cleanup old data (keep last 7 days)
      if (Math.random() < 0.1) { // Run cleanup 10% of the time
        console.log('Running cleanup of old data...');
        const deletedCount = await this.service.cleanupOldData(7);
        console.log(`Cleaned up ${deletedCount} old records`);
      }

    } catch (error) {
      console.error('Error in rate of change collection:', error);
    }
  }

  /**
   * Run once and exit (for cron jobs)
   */
  async runOnce(): Promise<void> {
    await this.collect();
    process.exit(0);
  }
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const mode = args[0] || 'once'; // 'once' or 'continuous'
  const intervalMinutes = parseInt(args[1] || '10', 10);

  const collector = new RateOfChangeCollector(intervalMinutes);

  if (mode === 'continuous') {
    collector.start();
  } else {
    collector.runOnce();
  }
}

export { RateOfChangeCollector };
