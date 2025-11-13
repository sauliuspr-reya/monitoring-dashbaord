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
    const destUrl = process.env.DESTINATION_DATABASE_URL || process.env.TARGET_DATABASE_URL;
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
            console.log('[db/connection] Using password from DESTINATION_DATABASE_URL (MONITORING_DB_PASSWORD appears incomplete)');
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
  
  console.log('[db/connection] Initializing database pool:', {
    host,
    port,
    database,
    user,
    hasPassword,
    usedFallback,
  });

  const config: PoolConfig = {
    host,
    port,
    database,
    user,
    password,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
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

