import type { NextApiRequest, NextApiResponse } from 'next';
import { BackupTaskService } from '@/lib/services/backup-task.service';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

const backupTaskService = new BackupTaskService();

/**
 * Create a subscription from a completed backup task
 * This endpoint uses the slot and publication from the backup task
 */
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
      backupTaskId,
      subscriptionName,
      sourceDbConnection,
      targetDbConnection,
    } = req.body;

    if (!backupTaskId) {
      return res.status(400).json({
        error: 'backupTaskId is required',
        details: 'Please provide the ID of the backup task to use.',
      });
    }

    if (!subscriptionName) {
      return res.status(400).json({
        error: 'subscriptionName is required',
        details: 'Please provide a name for the subscription.',
      });
    }

    // Get the backup task
    const backupTask = await backupTaskService.getTask(backupTaskId);
    if (!backupTask) {
      return res.status(404).json({
        error: 'Backup task not found',
        details: `No backup task found with ID: ${backupTaskId}`,
      });
    }

    // Verify the backup task has slot information
    if (!backupTask.slot_name || !backupTask.publication_name) {
      return res.status(400).json({
        error: 'Backup task does not have replication slot information',
        details: 'This backup task was created without replication enabled. You cannot create a subscription from it.',
      });
    }

    // Verify backup is completed
    if (backupTask.status !== 'completed') {
      return res.status(400).json({
        error: 'Backup task is not completed',
        details: `Backup task status is: ${backupTask.status}. Only completed backups can be used to create subscriptions.`,
      });
    }

    // Use provided connections or fall back to environment variables
    const finalSourceConnection = (sourceDbConnection && sourceDbConnection.trim() !== '') 
      ? sourceDbConnection 
      : (process.env.SOURCE_DATABASE_URL || '');
    const finalTargetConnection = (targetDbConnection && targetDbConnection.trim() !== '') 
      ? targetDbConnection 
      : (process.env.TARGET_DATABASE_URL || '');

    if (!finalSourceConnection || finalSourceConnection.trim() === '') {
      return res.status(400).json({
        error: 'Source database connection string is required',
        details: 'Please set SOURCE_DATABASE_URL environment variable or provide sourceDbConnection.',
      });
    }

    if (!finalTargetConnection || finalTargetConnection.trim() === '') {
      return res.status(400).json({
        error: 'Target database connection string is required',
        details: 'Please set TARGET_DATABASE_URL environment variable or provide targetDbConnection.',
      });
    }

    // Create connection pools
    const sourcePool = createSourceTargetPool(finalSourceConnection);
    const targetPool = createSourceTargetPool(finalTargetConnection);

    try {
      // Verify slot exists on source
      const slotCheck = await sourcePool.query(`
        SELECT COUNT(*) as count FROM pg_replication_slots WHERE slot_name = $1
      `, [backupTask.slot_name]);

      if (slotCheck.rows[0].count === '0') {
        await sourcePool.end();
        await targetPool.end();
        return res.status(404).json({
          error: 'Replication slot not found',
          details: `Slot '${backupTask.slot_name}' does not exist on source database. It may have been dropped.`,
        });
      }

      // Verify publication exists on source
      const pubCheck = await sourcePool.query(`
        SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
      `, [backupTask.publication_name]);

      if (pubCheck.rows[0].count === '0') {
        await sourcePool.end();
        await targetPool.end();
        return res.status(404).json({
          error: 'Publication not found',
          details: `Publication '${backupTask.publication_name}' does not exist on source database. It may have been dropped.`,
        });
      }

      // Check if subscription already exists on target
      const subCheck = await targetPool.query(`
        SELECT COUNT(*) as count FROM pg_subscription WHERE subname = $1
      `, [subscriptionName]);

      if (subCheck.rows[0].count !== '0') {
        await sourcePool.end();
        await targetPool.end();
        return res.status(409).json({
          error: 'Subscription already exists',
          details: `Subscription '${subscriptionName}' already exists on target database.`,
          hint: 'Drop the existing subscription first or use a different name.',
        });
      }

      // Parse source connection for subscription connection string
      let connString: string;
      try {
        const sourceUrl = new URL(finalSourceConnection);
        const sourceHost = sourceUrl.hostname;
        const sourcePort = sourceUrl.port || '5432';
        const sourceUser = decodeURIComponent(sourceUrl.username);
        const sourcePass = decodeURIComponent(sourceUrl.password);
        const sourceDb = sourceUrl.pathname.slice(1).split('?')[0];
        
        const escapedPass = sourcePass.replace(/'/g, "''");
        connString = `host=${sourceHost} port=${sourcePort} dbname=${sourceDb} user=${sourceUser} password='${escapedPass}'`;
      } catch (urlError) {
        connString = finalSourceConnection;
      }

      // Escape identifiers
      const escapedSubName = subscriptionName.replace(/"/g, '""');
      const escapedPubName = backupTask.publication_name.replace(/"/g, '""');
      const escapedSlotName = backupTask.slot_name.replace(/'/g, "''");
      const escapedConnString = connString.replace(/'/g, "''");
      
      // Create subscription using existing slot
      // IMPORTANT: create_slot = false and copy_data = false
      // because we're using the slot from the backup and data was already restored
      await targetPool.query(`
        CREATE SUBSCRIPTION "${escapedSubName}"
        CONNECTION '${escapedConnString}'
        PUBLICATION "${escapedPubName}"
        WITH (
          create_slot = false,
          slot_name = '${escapedSlotName}',
          copy_data = false,
          enabled = true,
          streaming = parallel
        )
      `);

      // Save to monitoring database
      const monitoringPool = getDbPool();
      const result = await monitoringPool.query(`
        INSERT INTO subscriptions (
          name, description, source_db_connection, target_db_connection,
          publication_name, subscription_name, slot_name, enabled, data_copy
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        subscriptionName,
        `Subscription created from backup task ${backupTaskId}`,
        finalSourceConnection,
        finalTargetConnection,
        backupTask.publication_name,
        subscriptionName,
        backupTask.slot_name,
        true,
        false, // data_copy = false because data was already restored
      ]);

      const subscriptionId = result.rows[0].id;

      // Get tables from publication to save to subscription_tables
      const pubTablesResult = await sourcePool.query(`
        SELECT tablename FROM pg_publication_tables WHERE pubname = $1
      `, [backupTask.publication_name]);

      for (const row of pubTablesResult.rows) {
        await monitoringPool.query(`
          INSERT INTO subscription_tables (
            subscription_id, table_name, schema_name, enabled
          ) VALUES ($1, $2, 'public', true)
          ON CONFLICT DO NOTHING
        `, [subscriptionId, row.tablename]);
      }

      res.status(201).json({
        success: true,
        id: subscriptionId,
        subscriptionName,
        slotName: backupTask.slot_name,
        publicationName: backupTask.publication_name,
        slotInitialLsn: backupTask.slot_initial_lsn,
        tables: pubTablesResult.rows.length,
        message: 'Subscription created successfully using existing slot from backup',
      });
    } finally {
      await sourcePool.end();
      await targetPool.end();
    }
  } catch (error: any) {
    console.error('[subscriptions/create-from-backup] Error:', error);
    res.status(500).json({
      error: 'Failed to create subscription from backup',
      message: error.message,
      details: error.detail || error.message,
    });
  }
}

