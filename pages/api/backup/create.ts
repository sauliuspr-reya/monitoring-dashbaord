import type { NextApiRequest, NextApiResponse } from 'next';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// Determine backup directory based on environment
async function getBackupDir(): Promise<string> {
  // Check environment variable first
  if (process.env.BACKUP_DIR) {
    return process.env.BACKUP_DIR;
  }
  
  // Check if /backup exists (Kubernetes pod)
  try {
    await fs.access('/backup');
    return '/backup';
  } catch {
    return './backup'; // Default for local development
  }
}

// Parse PostgreSQL connection string
function parseConnectionString(connString: string) {
  try {
    const url = new URL(connString);
    return {
      host: url.hostname,
      port: url.port || '5432',
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1).split('?')[0],
    };
  } catch {
    // Fallback: assume it's already in key=value format
    const params: any = {};
    connString.split(' ').forEach(param => {
      const [key, value] = param.split('=');
      if (key && value) {
        params[key] = value;
      }
    });
    return {
      host: params.host || params.hostname,
      port: params.port || '5432',
      user: params.user || params.userid,
      password: params.password || params.pass,
      database: params.database || params.dbname,
    };
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    const { tables, connectionString, schemaOnly = false } = req.body;

    if (!connectionString) {
      return res.status(400).json({ error: 'Connection string is required' });
    }

    if (!tables || !Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({ error: 'At least one table must be specified' });
    }

    // Parse connection string
    const conn = parseConnectionString(connectionString);

    // Determine backup directory
    const backupDir = await getBackupDir();
    await fs.mkdir(backupDir, { recursive: true });

    // Generate backup filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const tableList = tables.slice(0, 3).join('_');
    const filename = `backup_${timestamp}_${tableList}${tables.length > 3 ? `_and_${tables.length - 3}_more` : ''}.sql`;
    const filepath = path.join(backupDir, filename);

    // Build pg_dump command
    // Handle table names: if they don't have a schema prefix, assume 'public'
    // Also properly quote table names to handle case-sensitive names
    const tableArgs = tables.map(t => {
      // If table name already includes schema (contains a dot), use as-is
      // Otherwise, assume it's in the public schema
      let tableName = t.includes('.') ? t : `public.${t}`;
      
      // For pg_dump, we need to quote the entire identifier if it contains uppercase
      // or quote just the parts that need it. The format should be: schema."TableName"
      // or "Schema"."TableName" if both are case-sensitive
      const parts = tableName.split('.');
      if (parts.length === 2) {
        const [schema, table] = parts;
        // Quote schema only if it has uppercase
        const quotedSchema = /[A-Z]/.test(schema) ? `"${schema}"` : schema;
        // Quote table if it has uppercase or special chars
        const quotedTable = /[A-Z]/.test(table) || /[^a-z0-9_]/.test(table) ? `"${table}"` : table;
        return `-t ${quotedSchema}.${quotedTable}`;
      } else {
        // Single identifier (no schema), quote if needed
        const quoted = /[A-Z]/.test(tableName) || /[^a-z0-9_]/.test(tableName) ? `"${tableName}"` : tableName;
        return `-t ${quoted}`;
      }
    }).join(' ');
    // By default, include data. Only use --schema-only if explicitly requested
    const dataFlag = schemaOnly ? '--schema-only' : '';
    
    const command = `PGPASSWORD='${conn.password.replace(/'/g, "\\'")}' pg_dump ` +
      `-h ${conn.host} ` +
      `-p ${conn.port} ` +
      `-U ${conn.user} ` +
      `-d ${conn.database} ` +
      `${dataFlag} ` +
      `--no-owner ` +
      `--no-privileges ` +
      `${tableArgs} ` +
      `-f ${filepath}`;

    console.log(`[backup] Starting backup: ${tables.length} tables to ${filepath}`);

    // Execute backup
    // Note: maxBuffer is for stdout/stderr, not the file size
    // For large backups (200GB+), we increase buffer to handle verbose output
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 100 * 1024 * 1024, // 100MB buffer for large backup output
      env: {
        ...process.env,
        PGPASSWORD: conn.password,
      },
    });

    // Check if file was created
    try {
      const stats = await fs.stat(filepath);
      const fileSize = stats.size;

      console.log(`[backup] Backup completed: ${filepath} (${fileSize} bytes)`);

      res.status(200).json({
        success: true,
        filename,
        filepath,
        fileSize,
        tables: tables.length,
        schemaOnly,
        message: `Backup created successfully: ${filename}`,
      });
    } catch (statError) {
      console.error('[backup] Backup file not found after execution:', statError);
      return res.status(500).json({
        error: 'Backup command executed but file was not created',
        stderr: stderr || stdout,
      });
    }
  } catch (error: any) {
    console.error('[backup] Error creating backup:', error);
    res.status(500).json({
      error: 'Failed to create backup',
      message: error.message,
      details: error.stderr || error.stdout,
    });
  }
}

