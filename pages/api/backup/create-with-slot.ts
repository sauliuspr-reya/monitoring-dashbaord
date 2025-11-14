import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';
import { backupTaskStreamingService } from '@/lib/services/backup-task-streaming.service';
import { createSourceTargetPool } from '@/lib/db/connection';
import { promises as fs } from 'fs';
import path from 'path';

const backupTaskService = new BackupTaskService();

// Determine backup directory based on environment
async function getBackupDir(): Promise<string> {
  if (process.env.BACKUP_DIR) {
    return process.env.BACKUP_DIR;
  }
  
  try {
    await fs.access('/backup');
    return '/backup';
  } catch {
    return './backup';
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
    const { 
      tables, 
      excludeTables, 
      snapshotId,
      schemaOnly = false,
      enableReplication = false, // If true, creates publication and slot
    } = req.body;

    // Use SOURCE_DATABASE_URL from environment
    const sourceConnectionString = process.env.SOURCE_DATABASE_URL;

    if (!sourceConnectionString) {
      return res.status(400).json({ 
        error: 'SOURCE_DATABASE_URL environment variable is required' 
      });
    }

    // Tables are optional if excludeTables is provided
    if ((!tables || !Array.isArray(tables) || tables.length === 0) && 
        (!excludeTables || (typeof excludeTables === 'string' && excludeTables.trim().length === 0) || 
         (Array.isArray(excludeTables) && excludeTables.length === 0))) {
      return res.status(400).json({ 
        error: 'Either tables or excludeTables must be specified' 
      });
    }

    // Ensure backup directory exists
    const backupDir = await getBackupDir();
    try {
      await fs.mkdir(backupDir, { recursive: true });
    } catch (error: any) {
      return res.status(500).json({
        error: 'Backup directory is not accessible',
        message: error.message,
      });
    }

    const sourcePool = createSourceTargetPool(sourceConnectionString);
    let slotName: string | undefined;
    let publicationName: string | undefined;
    let slotInitialLsn: string | undefined;

    // Don't enable replication for schema-only backups
    const effectiveReplication = enableReplication && !schemaOnly;

    try {
      // Step 1: Create publication and slot if replication is enabled AND not schema-only
      // Schema-only backups don't need replication slots since there's no data to track
      if (effectiveReplication) {
        // Generate names
        const timestamp = Date.now();
        publicationName = `backup_pub_${timestamp}`;
        slotName = `backup_slot_${timestamp}`;

        const escapedPubName = `"${publicationName.replace(/"/g, '""')}"`;
        
        // Determine which tables to publish
        if (excludeTables && (Array.isArray(excludeTables) ? excludeTables.length > 0 : excludeTables.trim().length > 0)) {
          // If excluding, create publication for ALL TABLES
          // The exclude will be handled in the backup command
          await sourcePool.query(`CREATE PUBLICATION ${escapedPubName} FOR ALL TABLES`);
        } else if (tables && Array.isArray(tables) && tables.length > 0) {
          // Create publication for specific tables
          const tableList = tables.map((t: string) => {
            const escaped = t.replace(/"/g, '""');
            return `"${escaped}"`;
          }).join(', ');
          await sourcePool.query(`CREATE PUBLICATION ${escapedPubName} FOR TABLE ${tableList}`);
        } else {
          // Fallback: create for all tables
          await sourcePool.query(`CREATE PUBLICATION ${escapedPubName} FOR ALL TABLES`);
        }

        // Step 2: Create replication slot
        const slotResult = await sourcePool.query(`
          SELECT pg_create_logical_replication_slot($1, 'pgoutput')
        `, [slotName]);

        // Get the initial LSN after slot creation
        const lsnResult = await sourcePool.query(`
          SELECT 
            confirmed_flush_lsn AS initial_lsn,
            pg_current_wal_lsn() AS current_lsn
          FROM pg_replication_slots
          WHERE slot_name = $1
        `, [slotName]);

        slotInitialLsn = lsnResult.rows[0]?.initial_lsn || lsnResult.rows[0]?.current_lsn;

        console.log(`[backup/create-with-slot] Created publication: ${publicationName}, slot: ${slotName}, LSN: ${slotInitialLsn}`);
      }

      // Step 3: Create backup task with slot info
      // Only set snapshot/slot info if replication is enabled (not for schema-only)
      const task = await backupTaskService.createTask('backup', {
        tables: tables && Array.isArray(tables) && tables.length > 0 ? tables : undefined,
        excludeTables: excludeTables,
        snapshotId: effectiveReplication ? (snapshotId || `snapshot_${Date.now()}`) : undefined,
        slotName: slotName,
        publicationName: publicationName,
        slotInitialLsn: slotInitialLsn,
        connectionString: sourceConnectionString,
        schemaOnly,
        createdBy: req.headers['x-user'] as string || undefined,
      });

      // Step 4: Start backup in background with streaming
      backupTaskStreamingService.executeBackupTaskStreaming(task.id, sourceConnectionString).catch((error) => {
        console.error(`[backup/create-with-slot] Background task ${task.id} failed:`, error);
      });

      res.status(202).json({
        success: true,
        taskId: task.id,
        status: 'pending',
        message: 'Backup task created and queued',
        slotName,
        publicationName,
        slotInitialLsn,
      });
    } finally {
      await sourcePool.end();
    }
  } catch (error: any) {
    console.error('[backup/create-with-slot] Error:', error);
    res.status(500).json({
      error: 'Failed to create backup task',
      message: error.message,
    });
  }
}

