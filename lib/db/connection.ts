import { Pool, PoolConfig } from 'pg';

// Database connection pool for the monitoring database
// This is separate from the source/target databases being monitored
let pool: Pool | null = null;

/**
 * Safely decode and clean password from environment variable
 * Handles:
 * - Quoted strings (from .env files)
 * - URL-encoded passwords (if password appears to be URL-encoded)
 * - Special characters in passwords
 * 
 * Note: Kubernetes secrets are base64 encoded, but when exposed as env vars
 * they're already decoded. However, if the password itself was URL-encoded
 * when stored, we need to decode it.
 */
function decodePassword(rawPassword: string | undefined): string {
  if (!rawPassword) {
    return '';
  }

  let password = rawPassword;

  // Remove surrounding quotes (single or double) - common in .env files
  password = password.replace(/^['"]|['"]$/g, '');

  // Try URL decoding only if it looks like URL-encoded content
  // Check for URL-encoded patterns like %20, %40, etc.
  const urlEncodedPattern = /%[0-9A-Fa-f]{2}/i;
  if (urlEncodedPattern.test(password)) {
    try {
      const decoded = decodeURIComponent(password);
      // Only use decoded version if it's different (meaning it was actually encoded)
      if (decoded !== password) {
        console.log('[db/connection] Password appears URL-encoded, decoding...');
        password = decoded;
      }
    } catch (e) {
      // If URL decoding fails, use original password
      // This handles edge cases where %XX pattern exists but isn't valid encoding
      console.warn('[db/connection] URL decode failed (using original):', e instanceof Error ? e.message : 'Unknown error');
    }
  }

  return password;
}

/**
 * Extract password from a database connection URL
 * Useful as fallback when MONITORING_DB_PASSWORD is incomplete due to shell variable expansion
 */
function extractPasswordFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      // Password in URL is already URL-decoded by the URL parser
      return parsed.password;
    }
  } catch (e) {
    // Invalid URL, ignore
  }
  
  return null;
}

export function getDbPool(): Pool {
  if (pool) {
    return pool;
  }

  let rawPassword = process.env.MONITORING_DB_PASSWORD;
  const host = process.env.MONITORING_DB_HOST || 'localhost';
  const port = parseInt(process.env.MONITORING_DB_PORT || '5432');
  const database = process.env.MONITORING_DB_NAME || 'replication_monitoring';
  const user = process.env.MONITORING_DB_USER || 'postgres';

  // Fallback: If password seems incomplete (too short) or missing, try to extract from connection URL
  // This handles cases where $ in password causes shell variable expansion issues
  if (!rawPassword || rawPassword.length < 8) {
    const destUrl = process.env.TARGET_DATABASE_URL;
    if (destUrl && host && user) {
      // Check if the URL is for the same host/user as our monitoring DB
      try {
        const urlParsed = new URL(destUrl);
        const urlHost = urlParsed.hostname;
        const urlUser = urlParsed.username;
        
        // If it matches our monitoring DB connection, use the password from URL
        if (urlHost === host && urlUser === user) {
          const extractedPassword = extractPasswordFromUrl(destUrl);
          if (extractedPassword) {
            console.log('[db/connection] Using password from TARGET_DATABASE_URL (MONITORING_DB_PASSWORD appears incomplete)');
            rawPassword = extractedPassword;
          }
        }
      } catch (e) {
        // URL parsing failed, continue with original password
      }
    }
  }

  const password = decodePassword(rawPassword);
  
  // Log connection details (without password) for debugging
  const hasPassword = !!rawPassword;
  const usedFallback = rawPassword !== process.env.MONITORING_DB_PASSWORD;
  
  // Allow configuration via environment variable for production tuning
  const maxConnections = parseInt(process.env.MONITORING_DB_MAX_CONNECTIONS || '50', 10);
  
  console.log('[db/connection] Initializing database pool:', {
    host,
    port,
    database,
    user,
    hasPassword,
    usedFallback,
    maxConnections,
  });
  
  const config: PoolConfig = {
    host,
    port,
    database,
    user,
    password,
    max: maxConnections, // Increased from 20 to 50 for production workloads (configurable via MONITORING_DB_MAX_CONNECTIONS)
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000, // Increased from 2s to 30s to match source/target pools
    query_timeout: 60000, // 60 second query timeout
    statement_timeout: 60000, // 60 second statement timeout
  };

  pool = new Pool(config);
  
  // Add error handler to log connection issues
  pool.on('error', (err) => {
    console.error('[db/connection] Pool error:', {
      message: err.message,
      code: (err as any).code,
      // Don't log password, but log if it might be an auth issue
      isAuthError: (err as any).code === '28P01',
    });
  });

  return pool;
}

// Connection pool for source/target databases (for monitoring)
export function createSourceTargetPool(connectionString: string): Pool {
  // Allow configuration via environment variable for production tuning
  // Higher limit needed for production services + dashboard monitoring
  const maxConnections = parseInt(process.env.SOURCE_TARGET_DB_MAX_CONNECTIONS || '25', 10);
  
  const pool = new Pool({
    connectionString,
    max: maxConnections, // Increased from 10 to 25 for production workloads (configurable via SOURCE_TARGET_DB_MAX_CONNECTIONS)
    idleTimeoutMillis: 60000, // Increased to 60s to prevent premature connection closure
    connectionTimeoutMillis: 30000, // Increased from 5s to 30s for GCP Cloud SQL
    query_timeout: 60000, // 60 second query timeout
    statement_timeout: 60000, // 60 second statement timeout
  });

  // Add error handler to handle connection terminations
  pool.on('error', (err) => {
    console.error('[db/connection] Source/Target pool error:', {
      message: err.message,
      code: (err as any).code,
      // Log if it's a connection termination
      isConnectionTerminated: err.message?.includes('terminated') || err.message?.includes('unexpectedly'),
    });
  });

  // Handle connection terminations gracefully
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      console.error('[db/connection] Client error:', {
        message: err.message,
        code: (err as any).code,
      });
    });

    client.on('end', () => {
      console.log('[db/connection] Client connection ended');
    });
  });

  return pool;
}

/**
 * Retry a database query with exponential backoff
 * Useful for handling transient connection errors
 */
export async function retryQuery<T>(
  queryFn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await queryFn();
    } catch (error: any) {
      lastError = error;
      
      // Don't retry on certain errors
      if (
        error.message?.includes('password authentication failed') ||
        error.message?.includes('syntax error') ||
        error.message?.includes('permission denied') ||
        error.code === '28P01' // Authentication failure
      ) {
        throw error;
      }

      // Check if it's a connection error worth retrying
      const isConnectionError = 
        error.message?.includes('timeout') ||
        error.message?.includes('terminated') ||
        error.message?.includes('ECONNRESET') ||
        error.message?.includes('ECONNREFUSED') ||
        error.message?.includes('unexpectedly');

      if (!isConnectionError && attempt < maxRetries - 1) {
        // Not a connection error, but we'll retry anyway for transient errors
      } else if (!isConnectionError) {
        // Not a connection error and we're out of retries
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = initialDelay * Math.pow(2, attempt);
      console.warn(`[db/connection] Query failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms:`, error.message);
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // If we get here, all retries failed
  throw lastError || new Error('Query failed after retries');
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

