import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

interface BulkSubscriptionRequest {
  name: string;
  description?: string;
  tables: string[];
  sourceDbConnection: string;
  targetDbConnection: string;
  createPublication?: boolean;
  createSubscription?: boolean;
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
      name,
      description,
      tables,
      sourceDbConnection,
      targetDbConnection,
      createPublication = true,
      createSubscription = true,
    } = req.body as BulkSubscriptionRequest;

    if (!name || !tables || !Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: name, tables (array)',
      });
    }

    if (!sourceDbConnection || !targetDbConnection) {
      return res.status(400).json({
        error: 'Missing required fields: sourceDbConnection, targetDbConnection',
      });
    }

    // Generate names
    const publicationName = `reya_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_publication`;
    const subscriptionName = `reya_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_subscription`;
    const slotName = `reya_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_slot`;

    // Create connection pools
    const sourcePool = createSourceTargetPool(sourceDbConnection);
    const targetPool = createSourceTargetPool(targetDbConnection);

    const results = {
      publicationCreated: false,
      subscriptionCreated: false,
      errors: [] as string[],
    };

    try {
      // Step 1: Create publication on source
      if (createPublication) {
        try {
          const pubCheck = await sourcePool.query(`
            SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
          `, [publicationName]);

          if (pubCheck.rows[0].count === '0') {
            // Escape table names to prevent SQL injection
            const escapedPubName = `"${publicationName.replace(/"/g, '""')}"`;
            const tableList = tables.map(t => {
              const escaped = t.replace(/"/g, '""');
              return `"${escaped}"`;
            }).join(', ');
            
            await sourcePool.query(`
              CREATE PUBLICATION ${escapedPubName} FOR TABLE ${tableList}
            `);
            results.publicationCreated = true;
          } else {
            results.errors.push(`Publication ${publicationName} already exists`);
          }
        } catch (error: any) {
          results.errors.push(`Failed to create publication: ${error.message}`);
        }
      }

      // Step 2: Create subscription on target
      if (createSubscription) {
        try {
          const subCheck = await targetPool.query(`
            SELECT COUNT(*) as count FROM pg_subscription WHERE subname = $1
          `, [subscriptionName]);

          if (subCheck.rows[0].count === '0') {
            // Check if slot exists on source
            const slotCheck = await sourcePool.query(`
              SELECT COUNT(*) as count FROM pg_replication_slots WHERE slot_name = $1
            `, [slotName]);

            const createSlot = slotCheck.rows[0].count === '0';

            // Parse source connection for subscription connection string
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
            results.subscriptionCreated = true;
          } else {
            results.errors.push(`Subscription ${subscriptionName} already exists`);
          }
        } catch (error: any) {
          results.errors.push(`Failed to create subscription: ${error.message}`);
        }
      }

      // Step 3: Save to monitoring database
      const monitoringPool = getDbPool();
      let subscriptionId: number | null = null;

      try {
        const result = await monitoringPool.query(`
          INSERT INTO subscriptions (
            name, description, source_db_connection, target_db_connection,
            publication_name, subscription_name, slot_name, enabled
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `, [
          name,
          description || `Bulk subscription for ${tables.length} tables without active writers`,
          sourceDbConnection,
          targetDbConnection,
          publicationName,
          subscriptionName,
          slotName,
          true,
        ]);

        subscriptionId = result.rows[0].id;

        // Save table list
        for (const table of tables) {
          await monitoringPool.query(`
            INSERT INTO subscription_tables (
              subscription_id, table_name, schema_name, enabled
            ) VALUES ($1, $2, 'public', true)
            ON CONFLICT DO NOTHING
          `, [subscriptionId, table]);
        }
      } catch (error: any) {
        results.errors.push(`Failed to save to monitoring database: ${error.message}`);
      }

      if (results.errors.length > 0 && !results.publicationCreated && !results.subscriptionCreated) {
        return res.status(500).json({
          error: 'Failed to create subscription',
          details: results.errors,
        });
      }

      res.status(201).json({
        id: subscriptionId,
        name,
        publicationName,
        subscriptionName,
        slotName,
        tables: tables.length,
        publicationCreated: results.publicationCreated,
        subscriptionCreated: results.subscriptionCreated,
        errors: results.errors.length > 0 ? results.errors : undefined,
        message: 'Subscription created successfully',
      });
    } finally {
      await sourcePool.end();
      await targetPool.end();
    }
  } catch (error: any) {
    console.error('Error creating bulk subscription:', error);
    res.status(500).json({
      error: error.message || 'Failed to create bulk subscription',
      details: error.detail,
    });
  }
}

