import { Pool } from 'pg';
import { getDbPool, createSourceTargetPool } from '../db/connection';

export interface RateOfChangeData {
  tableName: string;
  schemaName: string;
  timestamp: Date;
  sourceRowCount: number;
  targetRowCount: number | null;
  rateOfChange1Min: number | null;
  rateOfChange10Min: number | null;
  rateOfChange1Hour: number | null;
  rateOfChange24Hour: number | null;
  measurementIntervalSeconds: number;
}

export class RateOfChangeService {
  private monitoringPool: Pool;

  constructor() {
    this.monitoringPool = getDbPool();
  }

  /**
   * Calculate and store rate of change for all tables
   * This should be called periodically (e.g., every 1-10 minutes)
   */
  async calculateAndStoreRateOfChange(
    sourceConnectionString: string,
    targetConnectionString?: string
  ): Promise<void> {
    const sourcePool = createSourceTargetPool(sourceConnectionString);
    const targetPool = targetConnectionString 
      ? createSourceTargetPool(targetConnectionString) 
      : null;

    try {
      // Get all tables from source database
      const tablesResult = await sourcePool.query(`
        SELECT 
          schemaname as schema_name,
          tablename as table_name
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, tablename
      `);

      const tables = tablesResult.rows;
      console.log(`Calculating rate of change for ${tables.length} tables...`);

      for (const table of tables) {
        try {
          await this.calculateTableRateOfChange(
            sourcePool,
            targetPool,
            table.schema_name,
            table.table_name
          );
        } catch (error) {
          console.error(`Error calculating rate for ${table.schema_name}.${table.table_name}:`, error);
          // Continue with other tables
        }
      }

      console.log('Rate of change calculation completed');
    } finally {
      await sourcePool.end();
      if (targetPool) await targetPool.end();
    }
  }

  /**
   * Calculate rate of change for a single table
   */
  private async calculateTableRateOfChange(
    sourcePool: Pool,
    targetPool: Pool | null,
    schemaName: string,
    tableName: string
  ): Promise<void> {
    // OPTIMIZATION: Use estimates instead of COUNT(*) - much faster
    // Get current row count from source (using estimate)
    const sourceCountResult = await sourcePool.query(`
      SELECT COALESCE(reltuples::bigint, 0) as estimate
      FROM pg_class
      WHERE relname = $1 
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
    `, [tableName, schemaName]);
    const sourceRowCount = parseInt(sourceCountResult.rows[0]?.estimate || '0', 10);

    // Get target row count if available (using estimate)
    let targetRowCount: number | null = null;
    if (targetPool) {
      try {
        const targetCountResult = await targetPool.query(`
          SELECT COALESCE(reltuples::bigint, 0) as estimate
          FROM pg_class
          WHERE relname = $1 
            AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
        `, [tableName, schemaName]);
        targetRowCount = parseInt(targetCountResult.rows[0]?.estimate || '0', 10);
      } catch (error) {
        // Table might not exist on target yet
        targetRowCount = null;
      }
    }

    // Calculate rates based on historical data
    const now = new Date();
    const rates = await this.calculateRates(
      schemaName,
      tableName,
      sourceRowCount,
      now
    );

    // Store the measurement
    await this.monitoringPool.query(
      `
      INSERT INTO table_rate_of_change (
        schema_name,
        table_name,
        timestamp,
        source_row_count,
        target_row_count,
        rate_of_change_1min,
        rate_of_change_10min,
        rate_of_change_1hour,
        rate_of_change_24hour,
        measurement_interval_seconds
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (schema_name, table_name, timestamp) 
      DO UPDATE SET
        source_row_count = EXCLUDED.source_row_count,
        target_row_count = EXCLUDED.target_row_count,
        rate_of_change_1min = EXCLUDED.rate_of_change_1min,
        rate_of_change_10min = EXCLUDED.rate_of_change_10min,
        rate_of_change_1hour = EXCLUDED.rate_of_change_1hour,
        rate_of_change_24hour = EXCLUDED.rate_of_change_24hour
      `,
      [
        schemaName,
        tableName,
        now,
        sourceRowCount,
        targetRowCount,
        rates.rate1Min,
        rates.rate10Min,
        rates.rate1Hour,
        rates.rate24Hour,
        60, // measurement interval in seconds
      ]
    );
  }

  /**
   * Calculate rate of change based on historical data
   */
  private async calculateRates(
    schemaName: string,
    tableName: string,
    currentRowCount: number,
    currentTime: Date
  ): Promise<{
    rate1Min: number | null;
    rate10Min: number | null;
    rate1Hour: number | null;
    rate24Hour: number | null;
  }> {
    const rates = {
      rate1Min: null as number | null,
      rate10Min: null as number | null,
      rate1Hour: null as number | null,
      rate24Hour: null as number | null,
    };

    // Get historical data points
    const historicalData = await this.monitoringPool.query(
      `
      SELECT 
        timestamp,
        source_row_count,
        EXTRACT(EPOCH FROM ($1::timestamp - timestamp)) / 60 as minutes_ago
      FROM table_rate_of_change
      WHERE schema_name = $2 
        AND table_name = $3
        AND timestamp < $1
      ORDER BY timestamp DESC
      LIMIT 1500  -- Keep last ~24 hours if measuring every minute
      `,
      [currentTime, schemaName, tableName]
    );

    if (historicalData.rows.length === 0) {
      return rates;
    }

    // Calculate 1-minute rate (using most recent data point)
    const data1Min = historicalData.rows.find(r => r.minutes_ago >= 0.5 && r.minutes_ago <= 1.5);
    if (data1Min) {
      const rowChange = currentRowCount - parseInt(data1Min.source_row_count, 10);
      const timeMinutes = parseFloat(data1Min.minutes_ago);
      rates.rate1Min = rowChange / timeMinutes;
    }

    // Calculate 10-minute rate
    const data10Min = historicalData.rows.find(r => r.minutes_ago >= 9 && r.minutes_ago <= 11);
    if (data10Min) {
      const rowChange = currentRowCount - parseInt(data10Min.source_row_count, 10);
      const timeMinutes = parseFloat(data10Min.minutes_ago);
      rates.rate10Min = rowChange / timeMinutes;
    }

    // Calculate 1-hour rate
    const data1Hour = historicalData.rows.find(r => r.minutes_ago >= 55 && r.minutes_ago <= 65);
    if (data1Hour) {
      const rowChange = currentRowCount - parseInt(data1Hour.source_row_count, 10);
      const timeMinutes = parseFloat(data1Hour.minutes_ago);
      rates.rate1Hour = rowChange / timeMinutes;
    }

    // Calculate 24-hour rate
    const data24Hour = historicalData.rows.find(r => r.minutes_ago >= 1430 && r.minutes_ago <= 1450);
    if (data24Hour) {
      const rowChange = currentRowCount - parseInt(data24Hour.source_row_count, 10);
      const timeMinutes = parseFloat(data24Hour.minutes_ago);
      rates.rate24Hour = rowChange / timeMinutes;
    }

    return rates;
  }

  /**
   * Get latest rate of change for a specific table
   */
  async getLatestRateOfChange(
    schemaName: string,
    tableName: string
  ): Promise<RateOfChangeData | null> {
    const result = await this.monitoringPool.query(
      `
      SELECT 
        table_name,
        schema_name,
        timestamp,
        source_row_count,
        target_row_count,
        rate_of_change_1min,
        rate_of_change_10min,
        rate_of_change_1hour,
        rate_of_change_24hour,
        measurement_interval_seconds
      FROM table_rate_of_change
      WHERE schema_name = $1 AND table_name = $2
      ORDER BY timestamp DESC
      LIMIT 1
      `,
      [schemaName, tableName]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      tableName: row.table_name,
      schemaName: row.schema_name,
      timestamp: row.timestamp,
      sourceRowCount: parseInt(row.source_row_count, 10),
      targetRowCount: row.target_row_count ? parseInt(row.target_row_count, 10) : null,
      rateOfChange1Min: row.rate_of_change_1min ? parseFloat(row.rate_of_change_1min) : null,
      rateOfChange10Min: row.rate_of_change_10min ? parseFloat(row.rate_of_change_10min) : null,
      rateOfChange1Hour: row.rate_of_change_1hour ? parseFloat(row.rate_of_change_1hour) : null,
      rateOfChange24Hour: row.rate_of_change_24hour ? parseFloat(row.rate_of_change_24hour) : null,
      measurementIntervalSeconds: row.measurement_interval_seconds,
    };
  }

  /**
   * Get rate of change time series for a table (for plotting)
   */
  async getRateOfChangeTimeSeries(
    schemaName: string,
    tableName: string,
    hoursBack: number = 24
  ): Promise<RateOfChangeData[]> {
    const result = await this.monitoringPool.query(
      `
      SELECT 
        table_name,
        schema_name,
        timestamp,
        source_row_count,
        target_row_count,
        rate_of_change_1min,
        rate_of_change_10min,
        rate_of_change_1hour,
        rate_of_change_24hour,
        measurement_interval_seconds
      FROM table_rate_of_change
      WHERE schema_name = $1 
        AND table_name = $2
        AND timestamp >= NOW() - INTERVAL '${hoursBack} hours'
      ORDER BY timestamp ASC
      `,
      [schemaName, tableName]
    );

    return result.rows.map(row => ({
      tableName: row.table_name,
      schemaName: row.schema_name,
      timestamp: row.timestamp,
      sourceRowCount: parseInt(row.source_row_count, 10),
      targetRowCount: row.target_row_count ? parseInt(row.target_row_count, 10) : null,
      rateOfChange1Min: row.rate_of_change_1min ? parseFloat(row.rate_of_change_1min) : null,
      rateOfChange10Min: row.rate_of_change_10min ? parseFloat(row.rate_of_change_10min) : null,
      rateOfChange1Hour: row.rate_of_change_1hour ? parseFloat(row.rate_of_change_1hour) : null,
      rateOfChange24Hour: row.rate_of_change_24hour ? parseFloat(row.rate_of_change_24hour) : null,
      measurementIntervalSeconds: row.measurement_interval_seconds,
    }));
  }

  /**
   * Get all latest rates for all tables (for the tables list view)
   */
  async getAllLatestRates(): Promise<Map<string, RateOfChangeData>> {
    const result = await this.monitoringPool.query(`
      SELECT * FROM latest_table_rate_of_change
    `);

    const ratesMap = new Map<string, RateOfChangeData>();
    
    for (const row of result.rows) {
      const key = `${row.schema_name}.${row.table_name}`;
      ratesMap.set(key, {
        tableName: row.table_name,
        schemaName: row.schema_name,
        timestamp: row.timestamp,
        sourceRowCount: parseInt(row.source_row_count, 10),
        targetRowCount: row.target_row_count ? parseInt(row.target_row_count, 10) : null,
        rateOfChange1Min: row.rate_of_change_1min ? parseFloat(row.rate_of_change_1min) : null,
        rateOfChange10Min: row.rate_of_change_10min ? parseFloat(row.rate_of_change_10min) : null,
        rateOfChange1Hour: row.rate_of_change_1hour ? parseFloat(row.rate_of_change_1hour) : null,
        rateOfChange24Hour: row.rate_of_change_24hour ? parseFloat(row.rate_of_change_24hour) : null,
        measurementIntervalSeconds: row.measurement_interval_seconds,
      });
    }

    return ratesMap;
  }

  /**
   * Clean up old data (keep last N days)
   */
  async cleanupOldData(daysToKeep: number = 7): Promise<number> {
    const result = await this.monitoringPool.query(
      `
      DELETE FROM table_rate_of_change
      WHERE timestamp < NOW() - INTERVAL '${daysToKeep} days'
      RETURNING id
      `
    );

    return result.rowCount || 0;
  }
}
