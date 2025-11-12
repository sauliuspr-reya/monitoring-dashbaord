import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

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
      name,
      description,
      sourceDbConnection,
      targetDbConnection,
      customTables, // Tables to replicate
    } = req.body;

    if (!name || !sourceDbConnection || !targetDbConnection) {
      return res.status(400).json({
        error: 'Missing required fields: name, sourceDbConnection, targetDbConnection',
      });
    }

    if (!customTables || customTables.length === 0) {
      return res.status(400).json({ error: 'No tables selected for subscription' });
    }

    const tables = customTables;

    // Generate names from subscription name (sanitize for SQL identifiers)
    const sanitizedName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const publicationName = `${sanitizedName}_publication`;
    const subscriptionName = `${sanitizedName}_subscription`;
    const slotName = `${sanitizedName}_slot`;

    // Create connection pools
    const sourcePool = createSourceTargetPool(sourceDbConnection);
    const targetPool = createSourceTargetPool(targetDbConnection);

    try {
      // Step 1: Check if publication already exists
      const pubCheck = await sourcePool.query(`
        SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
      `, [publicationName]);

      if (pubCheck.rows[0].count === '0') {
        // Step 2: Create publication on source
        // Escape table names to prevent SQL injection
        const escapedPubName = `"${publicationName.replace(/"/g, '""')}"`;
        const tableList = tables.map((t: string) => {
          const escaped = t.replace(/"/g, '""');
          return `"${escaped}"`;
        }).join(', ');
        
        await sourcePool.query(`
          CREATE PUBLICATION ${escapedPubName} FOR TABLE ${tableList}
        `);
      }

      // Step 3: Check if subscription already exists
      const subCheck = await targetPool.query(`
        SELECT COUNT(*) as count FROM pg_subscription WHERE subname = $1
      `, [subscriptionName]);

      if (subCheck.rows[0].count === '0') {
        // Step 4: Check if slot exists on source
        const slotCheck = await sourcePool.query(`
          SELECT COUNT(*) as count FROM pg_replication_slots WHERE slot_name = $1
        `, [slotName]);

        const createSlot = slotCheck.rows[0].count === '0';

        // Step 5: Create subscription on target
        // Parse source connection for subscription connection string
        // Handle both URL format and connection string format
        let connString: string;
        try {
          const sourceUrl = new URL(sourceDbConnection);
          const sourceHost = sourceUrl.hostname;
          const sourcePort = sourceUrl.port || '5432';
          const sourceUser = decodeURIComponent(sourceUrl.username);
          const sourcePass = decodeURIComponent(sourceUrl.password);
          const sourceDb = sourceUrl.pathname.slice(1).split('?')[0];
          
          // Escape single quotes in password
          const escapedPass = sourcePass.replace(/'/g, "''");
          connString = `host=${sourceHost} port=${sourcePort} dbname=${sourceDb} user=${sourceUser} password='${escapedPass}'`;
        } catch (urlError) {
          // If it's not a URL, assume it's already a connection string
          connString = sourceDbConnection;
        }

        // Escape identifiers to prevent SQL injection
        const escapedSubName = subscriptionName.replace(/"/g, '""');
        const escapedPubName = publicationName.replace(/"/g, '""');
        const escapedSlotName = slotName.replace(/'/g, "''");
        // Escape connection string - replace single quotes with two single quotes
        const escapedConnString = connString.replace(/'/g, "''");
        
        await targetPool.query(`
          CREATE SUBSCRIPTION "${escapedSubName}"
          CONNECTION '${escapedConnString}'
          PUBLICATION "${escapedPubName}"
          WITH (
            create_slot = ${createSlot},
            slot_name = '${escapedSlotName}',
            copy_data = false,
            enabled = true,
            streaming = parallel
          )
        `);
      }

      // Step 6: Save to monitoring database
      const monitoringPool = getDbPool();
      const result = await monitoringPool.query(`
        INSERT INTO subscriptions (
          name, description, source_db_connection, target_db_connection,
          publication_name, subscription_name, slot_name, enabled
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        name,
        description || `Subscription with ${tables.length} table${tables.length !== 1 ? 's' : ''}`,
        sourceDbConnection,
        targetDbConnection,
        publicationName,
        subscriptionName,
        slotName,
        true,
      ]).catch(() =>
        monitoringPool.query(`
          INSERT INTO replication_groups (
            name, description, source_db_connection, target_db_connection,
            publication_name, subscription_name, slot_name, enabled
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `, [
          name,
          description || `Subscription with ${tables.length} table${tables.length !== 1 ? 's' : ''}`,
          sourceDbConnection,
          targetDbConnection,
          publicationName,
          subscriptionName,
          slotName,
          true,
        ])
      );

      // Step 7: Save table list
      const subscriptionId = result.rows[0].id;
      for (const table of tables) {
        await monitoringPool.query(`
          INSERT INTO subscription_tables (
            subscription_id, table_name, schema_name, enabled
          ) VALUES ($1, $2, 'public', true)
          ON CONFLICT DO NOTHING
        `, [subscriptionId, table]).catch(() =>
          monitoringPool.query(`
            INSERT INTO replication_group_tables (
              group_id, table_name, schema_name, enabled
            ) VALUES ($1, $2, 'public', true)
            ON CONFLICT DO NOTHING
          `, [subscriptionId, table])
        );
      }

      res.status(201).json({
        id: subscriptionId,
        name: result.rows[0].name,
        publicationName,
        subscriptionName,
        slotName,
        tables: tables.length,
        message: 'Subscription created successfully',
      });
    } finally {
      await sourcePool.end();
      await targetPool.end();
    }
  } catch (error: any) {
    console.error('Error creating subscription:', error);
    res.status(500).json({
      error: error.message || 'Failed to create subscription',
      details: error.detail,
    });
  }
}

