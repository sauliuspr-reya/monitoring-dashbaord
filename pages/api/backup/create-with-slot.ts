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
    // For local runs, use ./backup in the project directory
    return path.join(process.cwd(), 'backup');
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
      name, // Optional backup name/description
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

    let slotName: string | undefined;
    let publicationName: string | undefined;

    // Don't enable replication for schema-only backups
    const effectiveReplication = enableReplication && !schemaOnly;

    // Generate filename from name or timestamp
    let filename: string | undefined;
    let sanitizedName: string | undefined;
    let sanitizedNameForSlot: string | undefined;
    
    if (name && name.trim()) {
      // For filenames: allow hyphens (filesystem-safe)
      // Use the name as-is (frontend already adds timestamp if needed)
      sanitizedName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      filename = sanitizedName;
      
      // For slot/publication names: PostgreSQL requires lowercase letters, numbers, and underscores only
      // Replace hyphens with underscores and convert to lowercase
      if (sanitizedName) {
        sanitizedNameForSlot = sanitizedName.replace(/-/g, '_').toLowerCase();
      }
    }

    if (effectiveReplication) {
      // Generate compact names to stay under PostgreSQL's 63 char limit
      // Format: {prefix}_{name12}_{timestamp} where name is truncated to 12 chars
      const timestamp = Date.now();
      const shortName = sanitizedNameForSlot 
        ? sanitizedNameForSlot.substring(0, 12) 
        : '';
      
      if (shortName) {
        publicationName = `p_${shortName}_${timestamp}`;
        slotName = `s_${shortName}_${timestamp}`;
      } else {
        publicationName = `p_${timestamp}`;
        slotName = `s_${timestamp}`;
      }
    }

    // Create backup task
    // We delegate slot creation to the background worker to ensure consistency (single transaction)
    const task = await backupTaskService.createTask('backup', {
      tables: tables && Array.isArray(tables) && tables.length > 0 ? tables : undefined,
      excludeTables: excludeTables,
      snapshotId: snapshotId, // If provided manually, use it (but usually we generate it)
      slotName: slotName,
      publicationName: publicationName,
      slotInitialLsn: undefined, // Will be populated by background worker
      connectionString: sourceConnectionString,
      schemaOnly,
      filename: filename, // Custom backup name/description
      createdBy: req.headers['x-user'] as string || undefined,
    });

    // Add createSlot flag to metadata if replication is enabled
    if (effectiveReplication) {
      await backupTaskService.updateTask(task.id, {
        metadata: {
          ...task.metadata,
          createSlot: true,
        }
      });
    }

    // Start backup in background with streaming
    backupTaskStreamingService.executeBackupTaskStreaming(task.id, sourceConnectionString).catch((error) => {
      console.error(`[backup/create-with-slot] Background task ${task.id} failed:`, error);
    });

    res.status(202).json({
      success: true,
      taskId: task.id,
      status: 'pending',
      message: 'Backup task created and queued. Replication slot will be created during backup initialization.',
      slotName,
      publicationName,
      // slotInitialLsn is not available yet
    });
  } catch (error: any) {
    console.error('[backup/create-with-slot] Error:', error);
    res.status(500).json({
      error: 'Failed to create backup task',
      message: error.message,
    });
  }
}

