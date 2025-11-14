import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool } from '@/lib/db/connection';

interface TableBackupInfo {
  tableName: string;
  lastBackupDate?: string;
  lastBackupId?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const pool = getDbPool();
    
    // Get the most recent completed backup for each table
    // We check the 'tables' array for included tables
    const result = await pool.query(`
      WITH table_backups AS (
        SELECT 
          UNNEST(tables) as table_name,
          id as backup_id,
          completed_at as backup_date,
          ROW_NUMBER() OVER (PARTITION BY UNNEST(tables) ORDER BY completed_at DESC NULLS LAST, created_at DESC) as rn
        FROM backup_tasks
        WHERE 
          task_type = 'backup'
          AND status = 'completed'
          AND tables IS NOT NULL
          AND array_length(tables, 1) > 0
          AND completed_at IS NOT NULL
      )
      SELECT 
        table_name,
        backup_id,
        backup_date
      FROM table_backups
      WHERE rn = 1
    `);

    // Convert to a map for easy lookup
    const backupInfoMap = new Map<string, TableBackupInfo>();
    
    // Helper function to normalize table names
    const normalizeTableName = (tableName: string): string => {
      // Remove schema prefix (e.g., "public.")
      let normalized = tableName.replace(/^public\./, '');
      // Remove quotes if present
      normalized = normalized.replace(/^"/, '').replace(/"$/, '');
      return normalized;
    };
    
    result.rows.forEach((row: any) => {
      // Normalize table name from database (might be "public.TableName" or "TableName" or '"TableName"')
      let normalizedTable = row.table_name;
      
      // Remove schema prefix
      normalizedTable = normalizedTable.replace(/^public\./i, '');
      
      // Remove quotes
      normalizedTable = normalizedTable.replace(/^"/, '').replace(/"$/, '');
      
      // Also try lowercase version for matching
      const normalizedLower = normalizedTable.toLowerCase();
      
      // Only set if this is a newer backup or we don't have one yet
      const existing = backupInfoMap.get(normalizedTable) || backupInfoMap.get(normalizedLower);
      if (!existing || (row.backup_date && (!existing.lastBackupDate || new Date(row.backup_date) > new Date(existing.lastBackupDate)))) {
        backupInfoMap.set(normalizedTable, {
          tableName: normalizedTable,
          lastBackupDate: row.backup_date ? new Date(row.backup_date).toISOString() : undefined,
          lastBackupId: row.backup_id,
        });
        // Also store lowercase version for case-insensitive matching
        if (normalizedLower !== normalizedTable) {
          backupInfoMap.set(normalizedLower, {
            tableName: normalizedTable,
            lastBackupDate: row.backup_date ? new Date(row.backup_date).toISOString() : undefined,
            lastBackupId: row.backup_id,
          });
        }
      }
    });

    return res.status(200).json({
      backupInfo: Array.from(backupInfoMap.values()),
    });
  } catch (error: any) {
    console.error('Error fetching table backup info:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch backup info',
      details: error.message 
    });
  }
}

