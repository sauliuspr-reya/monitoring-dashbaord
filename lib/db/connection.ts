import { Pool, PoolConfig } from 'pg';

// Database connection pool for the monitoring database
// This is separate from the source/target databases being monitored
let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (pool) {
    return pool;
  }

  // Handle quoted passwords (dotenv may include quotes)
  const password = (process.env.MONITORING_DB_PASSWORD || '').replace(/^['"]|['"]$/g, '');

  const config: PoolConfig = {
    host: process.env.MONITORING_DB_HOST || 'localhost',
    port: parseInt(process.env.MONITORING_DB_PORT || '5432'),
    database: process.env.MONITORING_DB_NAME || 'replication_monitoring',
    user: process.env.MONITORING_DB_USER || 'postgres',
    password: password,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };

  pool = new Pool(config);
  return pool;
}

// Connection pool for source/target databases (for monitoring)
export function createSourceTargetPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10, // Increased from 5 to handle more concurrent queries
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000, // Increased from 5s to 30s for GCP Cloud SQL
    query_timeout: 60000, // 60 second query timeout
    statement_timeout: 60000, // 60 second statement timeout
  });
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

