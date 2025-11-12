import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool } from '../../../lib/db/connection';

interface BackupSnapshot {
  id: string;
  timestamp: Date;
  size: number;
  duration: number;
  status: 'completed' | 'running' | 'failed';
}

interface BackupStatus {
  lastBackup?: BackupSnapshot;
  nextScheduled?: Date;
  backupCount: number;
  totalSize: number;
  oldestBackup?: Date;
  newestBackup?: Date;
  averageDuration: number;
  recentBackups: BackupSnapshot[];
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const pool = getDbPool();

    // Check if backup tracking table exists
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'backup_snapshots'
      );
    `);

    if (!tableExists.rows[0].exists) {
      // Return empty state if table doesn't exist yet
      return res.status(200).json({
        backupCount: 0,
        totalSize: 0,
        recentBackups: [],
        message: 'Backup tracking not yet configured'
      });
    }

    // Get backup statistics
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as backup_count,
        COALESCE(SUM(size_bytes), 0) as total_size,
        MIN(timestamp) as oldest_backup,
        MAX(timestamp) as newest_backup,
        AVG(EXTRACT(EPOCH FROM duration)) as avg_duration
      FROM backup_snapshots
      WHERE status = 'completed'
    `);

    // Get recent backups
    const recentBackups = await pool.query(`
      SELECT 
        snapshot_id as id,
        timestamp,
        size_bytes as size,
        EXTRACT(EPOCH FROM duration) as duration,
        status
      FROM backup_snapshots
      ORDER BY timestamp DESC
      LIMIT 10
    `);

    // Get last backup
    const lastBackup = recentBackups.rows.length > 0 ? recentBackups.rows[0] : null;

    // Calculate next scheduled backup (assuming 2-hour schedule)
    let nextScheduled: Date | undefined;
    if (lastBackup) {
      nextScheduled = new Date(lastBackup.timestamp);
      nextScheduled.setHours(nextScheduled.getHours() + 2);
    }

    const response: BackupStatus = {
      lastBackup: lastBackup ? {
        id: lastBackup.id,
        timestamp: lastBackup.timestamp,
        size: lastBackup.size,
        duration: lastBackup.duration,
        status: lastBackup.status
      } : undefined,
      nextScheduled,
      backupCount: parseInt(stats.rows[0].backup_count),
      totalSize: parseInt(stats.rows[0].total_size),
      oldestBackup: stats.rows[0].oldest_backup,
      newestBackup: stats.rows[0].newest_backup,
      averageDuration: parseFloat(stats.rows[0].avg_duration) || 0,
      recentBackups: recentBackups.rows.map(row => ({
        id: row.id,
        timestamp: row.timestamp,
        size: row.size,
        duration: row.duration,
        status: row.status
      }))
    };

    res.status(200).json(response);
  } catch (error: any) {
    console.error('Error fetching backup status:', error);
    res.status(500).json({ 
      error: 'Failed to fetch backup status',
      details: error.message 
    });
  }
}
