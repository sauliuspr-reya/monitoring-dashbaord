import type { NextApiRequest, NextApiResponse } from 'next';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

async function getBackupDir(): Promise<string> {
  if (process.env.BACKUP_DIR) {
    return process.env.BACKUP_DIR;
  }
  
  // Check if /backup exists (Kubernetes pod)
  try {
    await fs.access('/backup');
    return '/backup';
  } catch {
    return './backup';
  }
}

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
    const { filename, connectionString, dryRun = false } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Backup filename is required' });
    }

    if (!connectionString) {
      return res.status(400).json({ error: 'Connection string is required' });
    }

    // Parse connection string
    const conn = parseConnectionString(connectionString);

    // Get backup file path
    const backupDir = await getBackupDir();
    const filepath = path.join(backupDir, filename);

    // Check if file exists
    try {
      await fs.access(filepath);
    } catch {
      return res.status(404).json({ error: `Backup file not found: ${filename}` });
    }

    if (dryRun) {
      // Just verify the file exists and return info
      const stats = await fs.stat(filepath);
      return res.status(200).json({
        success: true,
        dryRun: true,
        filename,
        filepath,
        fileSize: stats.size,
        message: 'Dry run: File exists and is ready to restore',
      });
    }

    console.log(`[restore] Starting restore: ${filename} to ${conn.host}:${conn.port}/${conn.database}`);

    // Build psql command to restore
    const command = `PGPASSWORD='${conn.password.replace(/'/g, "\\'")}' psql ` +
      `-h ${conn.host} ` +
      `-p ${conn.port} ` +
      `-U ${conn.user} ` +
      `-d ${conn.database} ` +
      `-f ${filepath}`;

    // Execute restore
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PGPASSWORD: conn.password,
      },
    });

    console.log(`[restore] Restore completed: ${filename}`);

    res.status(200).json({
      success: true,
      filename,
      message: 'Restore completed successfully',
      stdout: stdout || undefined,
      warnings: stderr || undefined,
    });
  } catch (error: any) {
    console.error('[restore] Error restoring backup:', error);
    res.status(500).json({
      error: 'Failed to restore backup',
      message: error.message,
      details: error.stderr || error.stdout,
    });
  }
}

