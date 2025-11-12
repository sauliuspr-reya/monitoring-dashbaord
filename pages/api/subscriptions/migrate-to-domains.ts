import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';
import { TABLE_GROUPS } from '@/lib/table-groups';
import { GoldskyAnalysisService } from '@/lib/services/goldsky-analysis.service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { 
    sourceDbConnection, 
    targetDbConnection,
    dropOld = true,
    createNew = true,
  } = req.body;

  if (!sourceDbConnection || !targetDbConnection) {
    return res.status(400).json({
      error: 'Missing required fields: sourceDbConnection, targetDbConnection',
    });
  }

  const sourcePool = createSourceTargetPool(sourceDbConnection);
  const targetPool = createSourceTargetPool(targetDbConnection);
  const monitoringPool = getDbPool();

  const results = {
    dropped: {
      publication: false,
      subscription: false,
      slot: false,
      monitoring: false,
    },
    created: [] as Array<{
      name: string;
      publication: string;
      subscription: string;
      tables: number;
      success: boolean;
      error?: string;
    }>,
    errors: [] as string[],
  };

  try {
    // Step 1: Drop old reya_replication subscription and publication
    if (dropOld) {
      try {
        // Drop subscription on target (this will also drop the slot if it exists)
        const subCheck = await targetPool.query(`
          SELECT subname FROM pg_subscription WHERE subname = 'reya_replication'
        `);
        
        if (subCheck.rows.length > 0) {
          await targetPool.query(`DROP SUBSCRIPTION IF EXISTS reya_replication`);
          results.dropped.subscription = true;
        }

        // Drop publication on source
        const pubCheck = await sourcePool.query(`
          SELECT pubname FROM pg_publication WHERE pubname = 'reya_replication'
        `);
        
        if (pubCheck.rows.length > 0) {
          await sourcePool.query(`DROP PUBLICATION IF EXISTS reya_replication`);
          results.dropped.publication = true;
        }

        // Drop slot on source (if it still exists)
        const slotCheck = await sourcePool.query(`
          SELECT slot_name FROM pg_replication_slots WHERE slot_name = 'reya_replication_slot'
        `);
        
        if (slotCheck.rows.length > 0) {
          await sourcePool.query(`SELECT pg_drop_replication_slot('reya_replication_slot')`);
          results.dropped.slot = true;
        }

        // Remove from monitoring database
        await monitoringPool.query(`
          DELETE FROM subscriptions WHERE name = 'reya_replication' OR subscription_name = 'reya_replication'
        `).catch(() =>
          monitoringPool.query(`
            DELETE FROM replication_groups WHERE name = 'reya_replication' OR subscription_name = 'reya_replication'
          `)
        );
        results.dropped.monitoring = true;
      } catch (error: any) {
        results.errors.push(`Failed to drop old replication: ${error.message}`);
      }
    }

    // Step 2: Get all tables from source database
    const allTablesResult = await sourcePool.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    const allTables = new Set(allTablesResult.rows.map((r: any) => r.tablename));

    // Step 3: Get Goldsky tables to exclude
    const goldskyService = new GoldskyAnalysisService();
    const goldskyTables = await goldskyService.getGoldskyTables().catch(() => new Set<string>());

    // Step 4: Create domain-based subscriptions
    if (createNew) {
      for (const group of TABLE_GROUPS) {
        // Filter tables that exist in the database and are not Goldsky tables
        const validTables = group.tables.filter(
          table => allTables.has(table) && !goldskyTables.has(table)
        );

        if (validTables.length === 0) {
          results.created.push({
            name: group.name,
            publication: `reya_${group.name}_publication`,
            subscription: `reya_${group.name}_subscription`,
            tables: 0,
            success: false,
            error: 'No valid tables found',
          });
          continue;
        }

        const publicationName = `reya_${group.name}_publication`;
        const subscriptionName = `reya_${group.name}_subscription`;
        const slotName = `reya_${group.name}_slot`;

        try {
          // Create publication
          const pubCheck = await sourcePool.query(`
            SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
          `, [publicationName]);

          if (pubCheck.rows[0].count === '0') {
            const escapedPubName = `"${publicationName.replace(/"/g, '""')}"`;
            const tableList = validTables.map(t => {
              const escaped = t.replace(/"/g, '""');
              return `"${escaped}"`;
            }).join(', ');
            
            await sourcePool.query(`
              CREATE PUBLICATION ${escapedPubName} FOR TABLE ${tableList}
            `);
          }

          // Create subscription
          const subCheck = await targetPool.query(`
            SELECT COUNT(*) as count FROM pg_subscription WHERE subname = $1
          `, [subscriptionName]);

          if (subCheck.rows[0].count === '0') {
            // Parse source connection for subscription connection string
            let connString: string;
            try {
              const sourceUrl = new URL(sourceDbConnection);
              const sourceHost = sourceUrl.hostname;
              const sourcePort = sourceUrl.port || '5432';
              const sourceUser = decodeURIComponent(sourceUrl.username);
              const sourcePass = decodeURIComponent(sourceUrl.password);
              const sourceDb = sourceUrl.pathname.slice(1).split('?')[0];
              
              const escapedPass = sourcePass.replace(/'/g, "''");
              connString = `host=${sourceHost} port=${sourcePort} dbname=${sourceDb} user=${sourceUser} password='${escapedPass}'`;
            } catch (urlError) {
              connString = sourceDbConnection;
            }

            const slotCheck = await sourcePool.query(`
              SELECT COUNT(*) as count FROM pg_replication_slots WHERE slot_name = $1
            `, [slotName]);

            const createSlot = slotCheck.rows[0].count === '0';

            const escapedSubName = subscriptionName.replace(/"/g, '""');
            const escapedPubName = publicationName.replace(/"/g, '""');
            const escapedSlotName = slotName.replace(/'/g, "''");
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

          // Save to monitoring database
          let monitoringResult;
          try {
            monitoringResult = await monitoringPool.query(`
              INSERT INTO subscriptions (
                name, description, source_db_connection, target_db_connection,
                publication_name, subscription_name, slot_name, enabled
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (subscription_name) DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                enabled = EXCLUDED.enabled
              RETURNING *
            `, [
              group.name,
              group.description,
              sourceDbConnection,
              targetDbConnection,
              publicationName,
              subscriptionName,
              slotName,
              true,
            ]);
          } catch (error: any) {
            // Try with replication_groups table (backward compatibility)
            monitoringResult = await monitoringPool.query(`
              INSERT INTO replication_groups (
                name, description, source_db_connection, target_db_connection,
                publication_name, subscription_name, slot_name, enabled
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT DO NOTHING
              RETURNING *
            `, [
              group.name,
              group.description,
              sourceDbConnection,
              targetDbConnection,
              publicationName,
              subscriptionName,
              slotName,
              true,
            ]);
          }

          // Only save table list if we successfully created the subscription record
          if (monitoringResult && monitoringResult.rows.length > 0) {
            const subscriptionId = monitoringResult.rows[0].id;

            // Save table list
            for (const table of validTables) {
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
          }

          results.created.push({
            name: group.name,
            publication: publicationName,
            subscription: subscriptionName,
            tables: validTables.length,
            success: true,
          });
        } catch (error: any) {
          results.created.push({
            name: group.name,
            publication: publicationName,
            subscription: subscriptionName,
            tables: validTables.length,
            success: false,
            error: error.message,
          });
          results.errors.push(`Failed to create ${group.name}: ${error.message}`);
        }
      }
    }

    res.status(200).json({
      success: results.errors.length === 0,
      dropped: results.dropped,
      created: results.created,
      summary: {
        totalGroups: TABLE_GROUPS.length,
        successful: results.created.filter(c => c.success).length,
        failed: results.created.filter(c => !c.success).length,
        totalTables: results.created.reduce((sum, c) => sum + c.tables, 0),
      },
      errors: results.errors.length > 0 ? results.errors : undefined,
    });
  } catch (error: any) {
    console.error('Error migrating to domain subscriptions:', error);
    res.status(500).json({
      error: error.message || 'Failed to migrate subscriptions',
      details: error.detail,
      partialResults: results,
    });
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

