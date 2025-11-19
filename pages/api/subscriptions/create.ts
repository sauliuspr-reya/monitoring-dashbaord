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
      customTables, // Tables to replicate (when using existing publications, this is the selected subset)
      excludeTables, // Tables to exclude (when creating new publication in exclude mode)
      dataCopy = false, // Whether to copy existing data
      useExistingPublication = false, // Whether to use an existing publication
      existingPublicationName, // Name of existing publication to use (deprecated, use existingPublicationNames)
      existingPublicationNames, // Array of publication names to use (supports multiple)
    } = req.body;

    // Fall back to environment variables if connection strings are not provided or empty
    const finalSourceConnection = (sourceDbConnection && sourceDbConnection.trim() !== '') 
      ? sourceDbConnection 
      : (process.env.SOURCE_DATABASE_URL || '');
    const finalTargetConnection = (targetDbConnection && targetDbConnection.trim() !== '') 
      ? targetDbConnection 
      : (process.env.TARGET_DATABASE_URL || '');

    if (!name) {
      return res.status(400).json({
        error: 'Missing required field: name',
        details: 'Please provide a name for the subscription.',
      });
    }

    if (!finalSourceConnection || finalSourceConnection.trim() === '') {
      return res.status(400).json({
        error: 'Source database connection string is required',
        details: 'Please set SOURCE_DATABASE_URL environment variable or provide a custom connection string.',
      });
    }

    if (!finalTargetConnection || finalTargetConnection.trim() === '') {
      return res.status(400).json({
        error: 'Target database connection string is required',
        details: 'Please set TARGET_DATABASE_URL environment variable or provide a custom connection string.',
      });
    }

    // Basic validation: connection strings should look like PostgreSQL connection strings
    const postgresUrlPattern = /^postgres(ql)?:\/\//i;
    const postgresConnPattern = /^(host|user|password|dbname|port)=/i;
    
    if (!postgresUrlPattern.test(finalSourceConnection) && !postgresConnPattern.test(finalSourceConnection)) {
      return res.status(400).json({
        error: 'Invalid source database connection string format',
        details: 'Connection string should be a PostgreSQL URL (postgresql://...) or connection string (host=... user=...).',
      });
    }

    if (!postgresUrlPattern.test(finalTargetConnection) && !postgresConnPattern.test(finalTargetConnection)) {
      return res.status(400).json({
        error: 'Invalid target database connection string format',
        details: 'Connection string should be a PostgreSQL URL (postgresql://...) or connection string (host=... user=...).',
      });
    }

    // If using existing publication, we don't need customTables
    // If creating new publication, we need either customTables (include mode) or excludeTables (exclude mode)
    if (!useExistingPublication && (!customTables || customTables.length === 0) && (!excludeTables || excludeTables.length === 0)) {
      return res.status(400).json({ error: 'No tables selected for subscription. Please select tables to include or exclude.' });
    }

    // Support both old single publication and new multiple publications
    const publicationNames = useExistingPublication 
      ? (existingPublicationNames || (existingPublicationName ? [existingPublicationName] : []))
      : [];
    
    if (useExistingPublication && publicationNames.length === 0) {
      return res.status(400).json({ error: 'At least one publication must be selected when useExistingPublication is true' });
    }
    
    if (useExistingPublication && customTables && customTables.length === 0) {
      return res.status(400).json({ error: 'At least one table must be selected from the publications' });
    }

    // Generate names from subscription name (sanitize for SQL identifiers)
    const sanitizedName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const subscriptionName = `${sanitizedName}_subscription`;
    const slotName = `${sanitizedName}_slot`;

    // Create connection pools
    let sourcePool, targetPool;
    try {
      sourcePool = createSourceTargetPool(finalSourceConnection);
      targetPool = createSourceTargetPool(finalTargetConnection);
    } catch (poolError: any) {
      return res.status(400).json({
        error: 'Failed to create database connection pools',
        details: poolError.message || 'Invalid connection string format',
      });
    }

    try {
      // Test connections before proceeding
      try {
        await sourcePool.query('SELECT 1');
      } catch (sourceError: any) {
        await sourcePool.end().catch(() => {});
        await targetPool.end().catch(() => {});
        return res.status(401).json({
          error: 'Failed to connect to source database',
          details: sourceError.message || 'Authentication failed. Please check your source database connection string and credentials.',
          hint: sourceError.message?.includes('password authentication failed') 
            ? 'Password authentication failed. Please verify the username and password in your source database connection string.'
            : 'Please verify the source database connection string is correct and the database is accessible.',
        });
      }

      try {
        await targetPool.query('SELECT 1');
      } catch (targetError: any) {
        await sourcePool.end().catch(() => {});
        await targetPool.end().catch(() => {});
        return res.status(401).json({
          error: 'Failed to connect to target database',
          details: targetError.message || 'Authentication failed. Please check your target database connection string and credentials.',
          hint: targetError.message?.includes('password authentication failed')
            ? 'Password authentication failed. Please verify the username and password in your target database connection string.'
            : 'Please verify the target database connection string is correct and the database is accessible.',
        });
      }

      // Step 1: Handle publications
      let finalPublicationName: string = ''; // For database storage
      let escapedPubName: string = ''; // For CREATE SUBSCRIPTION command
      let tables: string[] = []; // Tables that will be replicated
      
      if (useExistingPublication) {
        // Verify all existing publications exist
        for (const pubName of publicationNames) {
          const pubCheck = await sourcePool.query(`
            SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
          `, [pubName]);

          if (pubCheck.rows[0].count === '0') {
            await sourcePool.end();
            await targetPool.end();
            return res.status(404).json({
              error: 'Publication not found',
              details: `Publication '${pubName}' does not exist on source database.`,
            });
          }
        }
        
        // If customTables are provided, verify they exist in the selected publications
        if (customTables && customTables.length > 0) {
          // Get all tables from selected publications
          const allPubTables: string[] = [];
          for (const pubName of publicationNames) {
            const pubTablesResult = await sourcePool.query(`
              SELECT schemaname || '.' || tablename AS table_name
              FROM pg_publication_tables
              WHERE pubname = $1
            `, [pubName]);
            const pubTables = pubTablesResult.rows.map((r: any) => r.table_name);
            allPubTables.push(...pubTables);
          }
          
          // Check if all selected tables are in the publications
          const invalidTables = customTables.filter((t: string) => !allPubTables.includes(t));
          if (invalidTables.length > 0) {
            await sourcePool.end();
            await targetPool.end();
            return res.status(400).json({
              error: 'Invalid table selection',
              details: `The following tables are not in the selected publications: ${invalidTables.join(', ')}`,
            });
          }
        }
      } else {
        // Create new publication
        const publicationName = `${sanitizedName}_publication`;
        escapedPubName = `"${publicationName.replace(/"/g, '""')}"`;
        finalPublicationName = publicationName;
        
        const pubCheck = await sourcePool.query(`
          SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
        `, [publicationName]);

        if (pubCheck.rows[0].count === '0') {
          // Step 2: Create publication on source
          if (excludeTables && excludeTables.length > 0) {
            // In exclude mode, get all tables and remove excluded ones
            const allTablesResult = await sourcePool.query(`
              SELECT schemaname || '.' || tablename AS table_name
              FROM pg_tables
              WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              ORDER BY schemaname, tablename
            `);
            
            const allTables = allTablesResult.rows.map((r: any) => r.table_name);
            const excludedSet = new Set(excludeTables.map((t: string) => t.toLowerCase()));
            const includedTables = allTables.filter((t: string) => !excludedSet.has(t.toLowerCase()));
            
            if (includedTables.length === 0) {
              await sourcePool.end();
              await targetPool.end();
              return res.status(400).json({
                error: 'No tables to replicate',
                details: 'All tables are excluded. Please exclude fewer tables or use include mode.',
              });
            }
            
            // Set tables to included tables
            tables = includedTables;
            
            // Create publication with included tables
            const tableList = includedTables.map((t: string) => {
              const escaped = t.replace(/"/g, '""');
              return `"${escaped}"`;
            }).join(', ');
            await sourcePool.query(`
              CREATE PUBLICATION ${escapedPubName} FOR TABLE ${tableList}
            `);
          } else if (customTables && customTables.length > 0) {
            // Create publication for specific tables
            tables = customTables;
            const tableList = customTables.map((t: string) => {
              const escaped = t.replace(/"/g, '""');
              return `"${escaped}"`;
            }).join(', ');
            await sourcePool.query(`
              CREATE PUBLICATION ${escapedPubName} FOR TABLE ${tableList}
            `);
          } else {
            // Fallback: create for all tables
            const allTablesResult = await sourcePool.query(`
              SELECT schemaname || '.' || tablename AS table_name
              FROM pg_tables
              WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              ORDER BY schemaname, tablename
            `);
            tables = allTablesResult.rows.map((r: any) => r.table_name);
            
            await sourcePool.query(`
              CREATE PUBLICATION ${escapedPubName} FOR ALL TABLES
            `);
          }
        } else {
          // Publication exists - get all tables from it
          const pubTablesResult = await sourcePool.query(`
            SELECT schemaname || '.' || tablename AS table_name
            FROM pg_publication_tables
            WHERE pubname = $1
          `, [publicationName]);
          tables = pubTablesResult.rows.map((r: any) => r.table_name);
          
          // If customTables provided, add missing tables to publication
          if (customTables && customTables.length > 0) {
            const existingPubTables = pubTablesResult.rows.map((r: any) => r.table_name);
            const missingTables = customTables.filter((t: string) => !existingPubTables.includes(t));
            
            // Add any missing tables to the existing publication
            if (missingTables.length > 0) {
              for (const table of missingTables) {
                const escapedTable = `"${table.replace(/"/g, '""')}"`;
                try {
                  await sourcePool.query(`
                    ALTER PUBLICATION ${escapedPubName} ADD TABLE ${escapedTable}
                  `);
                } catch (alterError: any) {
                  console.warn(`Failed to add table ${table} to publication:`, alterError.message);
                  // Continue with other tables
                }
              }
              // Update tables list to include newly added tables
              tables = [...new Set([...tables, ...missingTables])];
            }
          }
        }
      }

      // Step 3: Check if subscription already exists
      const subCheck = await targetPool.query(`
        SELECT COUNT(*) as count FROM pg_subscription WHERE subname = $1
      `, [subscriptionName]);

      if (subCheck.rows[0].count !== '0') {
        await sourcePool.end();
        await targetPool.end();
        return res.status(409).json({
          error: 'Subscription already exists',
          details: `Subscription '${subscriptionName}' already exists on target database`,
          hint: 'Drop the existing subscription first or use a different name',
        });
      }

      // Step 4: Check if slot exists on source
      const slotCheck = await sourcePool.query(`
        SELECT COUNT(*) as count FROM pg_replication_slots WHERE slot_name = $1
      `, [slotName]);

      const createSlot = slotCheck.rows[0].count === '0';
      
      // If slot exists but subscription doesn't, warn user
      if (!createSlot) {
        console.warn(`Replication slot '${slotName}' already exists on source. Will use existing slot.`);
      }

      // Step 5: Validate that tables exist on target database
      // PostgreSQL requires tables to exist on subscriber before creating subscription
      let tablesToCheck: string[] = [];
      
      if (useExistingPublication) {
        // Get all tables from selected publications
        for (const pubName of publicationNames) {
          const pubTablesResult = await sourcePool.query(`
            SELECT schemaname || '.' || tablename AS table_name
            FROM pg_publication_tables
            WHERE pubname = $1
          `, [pubName]);
          const pubTables = pubTablesResult.rows.map((r: any) => r.table_name);
          tablesToCheck.push(...pubTables);
        }
        
        // If customTables are provided, only check those
        // NOTE: We'll create a new publication with only selected tables
        if (customTables && customTables.length > 0) {
          tablesToCheck = customTables;
        }
      } else {
        // For new publication, check the tables we're creating it for
        if (excludeTables && excludeTables.length > 0) {
          // In exclude mode, we need to get all tables first
          const allTablesResult = await sourcePool.query(`
            SELECT schemaname || '.' || tablename AS table_name
            FROM pg_tables
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY schemaname, tablename
          `);
          const allTables = allTablesResult.rows.map((r: any) => r.table_name);
          tablesToCheck = allTables.filter((t: string) => !excludeTables.includes(t));
        } else if (tables && tables.length > 0) {
          tablesToCheck = tables;
        }
      }
      
      // Remove duplicates
      tablesToCheck = [...new Set(tablesToCheck)];
      
      // Check which tables exist on target
    const parseTableIdentifier = (identifier: string): { schema: string; table: string } => {
      const trimmed = identifier.trim();
      if (trimmed.includes('.')) {
        const [schemaPart, tablePart] = trimmed.split('.', 2);
        return {
          schema: schemaPart.replace(/^"|"$/g, '') || 'public',
          table: tablePart.replace(/^"|"$/g, ''),
        };
      }
      return { schema: 'public', table: trimmed.replace(/^"|"$/g, '') };
    };

    const quoteIdentifier = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

    const buildQualifiedName = (schema: string, table: string) => {
      const quotedTable = quoteIdentifier(table);
      if (!schema || schema === 'public') {
        return `public.${quotedTable}`;
      }
      return `${quoteIdentifier(schema)}.${quotedTable}`;
    };

    if (tablesToCheck.length > 0) {
        const missingTables: string[] = [];
        const emptyTables: string[] = [];
        
        for (const table of tablesToCheck) {
          const { schema, table: rawTableName } = parseTableIdentifier(table);
          const cleanTableName = rawTableName;
          const qualifiedName = buildQualifiedName(schema, cleanTableName);
          
          // Use to_regclass to resolve the table (handles quoted identifiers)
          const regclassResult = await targetPool.query(
            `SELECT to_regclass($1) AS regclass`,
            [qualifiedName]
          );
          
          if (!regclassResult.rows[0]?.regclass) {
            missingTables.push(table);
          } else if (dataCopy === false) {
            // If copy_data = false, check if table has data (baseline should be restored)
            // Use fast estimate (reltuples) to avoid slow COUNT(*) on large tables
            try {
              const rowCountResult = await targetPool.query(
                `
                  SELECT COALESCE(c.reltuples::bigint, 0) AS estimate
                  FROM pg_class c
                  WHERE c.oid = to_regclass($1)::oid
                `,
                [qualifiedName]
              );
              
              const rowEstimate = parseInt(rowCountResult.rows[0]?.estimate || '0', 10);
              
              // If table exists but has no data and copy_data = false, warn user
              if (rowEstimate === 0) {
                // Double-check with actual count for small tables (more accurate)
                const actualCountResult = await targetPool.query(
                  `SELECT COUNT(*)::bigint AS count FROM ${qualifiedName}`
                ).catch(() => ({ rows: [{ count: '0' }] }));
                
                const actualCount = parseInt(actualCountResult.rows[0]?.count || '0', 10);
                if (actualCount === 0) {
                  emptyTables.push(table);
                }
              }
            } catch (err) {
              // If we can't check row count, continue (table exists, that's the main requirement)
              console.warn(`Could not check row count for table ${table}:`, err);
            }
          }
        }
        
        if (missingTables.length > 0) {
          await sourcePool.end();
          await targetPool.end();
          return res.status(400).json({
            error: 'Tables do not exist on target database',
            details: `The following tables from the publication do not exist on the target database: ${missingTables.join(', ')}`,
            hint: 'Before creating a subscription, you must restore a baseline backup (schema + data) to the target database. This ensures the target has the same schema and initial data as the source at the backup point.',
            missingTables: missingTables,
            workflow: [
              '1. Create a backup from source (with replication slot if needed)',
              '2. Restore the backup to target database',
              '3. Create subscription with copy_data = false (data already copied)',
            ],
          });
        }
        
        // Warn if tables exist but are empty and copy_data = false
        if (emptyTables.length > 0 && dataCopy === false) {
          console.warn(`Warning: ${emptyTables.length} tables exist but are empty. Baseline backup may not have been restored.`);
          // Don't fail, but log warning - user might intentionally have empty tables
        }
      }

      // Step 6: Create subscription on target
      // Parse source connection for subscription connection string
      // Handle both URL format and connection string format
      let connString: string;
      try {
        const sourceUrl = new URL(finalSourceConnection);
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
        connString = finalSourceConnection;
      }

      // Escape identifiers to prevent SQL injection
      const escapedSubName = subscriptionName.replace(/"/g, '""');
      const escapedSlotName = slotName.replace(/'/g, "''");
      // Escape connection string - replace single quotes with two single quotes
      const escapedConnString = connString.replace(/'/g, "''");
      
      // Build publication list for CREATE SUBSCRIPTION
      let publicationList: string;
      
      if (useExistingPublication) {
        // If customTables are provided, create a NEW publication with only selected tables
        // This allows filtering tables when using existing publications
        if (customTables && customTables.length > 0) {
          // Create a new publication with only the selected tables
          const filteredPubName = `${subscriptionName}_filtered_publication`;
          const escapedFilteredPubName = filteredPubName.replace(/"/g, '""');
          
          // Check if filtered publication already exists
          const filteredPubCheck = await sourcePool.query(`
            SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
          `, [filteredPubName]);
          
          if (filteredPubCheck.rows[0].count === '0') {
            // Create new publication with only selected tables
            const tableList = customTables.map((t: string) => {
              const escaped = t.replace(/"/g, '""');
              return `"${escaped}"`;
            }).join(', ');
            
            await sourcePool.query(`
              CREATE PUBLICATION "${escapedFilteredPubName}" FOR TABLE ${tableList}
            `);
            
            console.log(`Created filtered publication '${filteredPubName}' with ${customTables.length} tables`);
          }
          
          // Use the filtered publication instead of the original
          publicationList = `"${escapedFilteredPubName}"`;
          finalPublicationName = filteredPubName;
          // Set tables to the filtered list
          tables = customTables;
        } else {
          // No customTables - use existing publications as-is
          const escapedPubNames = publicationNames.map((pubName: string) => 
            `"${pubName.replace(/"/g, '""')}"`
          );
          publicationList = escapedPubNames.join(', ');
          finalPublicationName = publicationNames.join(','); // Store as comma-separated
          
          // Get all tables from all publications
          const allPubTables: string[] = [];
          for (const pubName of publicationNames) {
            const pubTablesResult = await sourcePool.query(`
              SELECT schemaname || '.' || tablename AS table_name
              FROM pg_publication_tables
              WHERE pubname = $1
            `, [pubName]);
            const pubTables = pubTablesResult.rows.map((r: any) => r.table_name);
            allPubTables.push(...pubTables);
          }
          tables = [...new Set(allPubTables)]; // Remove duplicates
        }
      } else {
        // Single new publication - escapedPubName already defined above
        publicationList = escapedPubName;
      }
      
      await targetPool.query(`
        CREATE SUBSCRIPTION "${escapedSubName}"
        CONNECTION '${escapedConnString}'
        PUBLICATION ${publicationList}
        WITH (
          create_slot = ${createSlot},
          slot_name = '${escapedSlotName}',
          copy_data = ${dataCopy ? 'true' : 'false'},
          enabled = true,
          streaming = parallel
        )
      `);

      // Step 7: Save to monitoring database
      const monitoringPool = getDbPool();
      const result = await monitoringPool.query(`
        INSERT INTO subscriptions (
          name, description, source_db_connection, target_db_connection,
          publication_name, subscription_name, slot_name, enabled, data_copy
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        name,
        description || `Subscription with ${tables.length} table${tables.length !== 1 ? 's' : ''}`,
        finalSourceConnection,
        finalTargetConnection,
        finalPublicationName,
        subscriptionName,
        slotName,
        true,
        dataCopy,
      ]);

      // Step 7: Save table list
      const subscriptionId = result.rows[0].id;
      // Use customTables if provided (filtered selection), otherwise use all tables from publication
      const tablesToSave = (useExistingPublication && customTables && customTables.length > 0) 
        ? customTables 
        : tables;
      
      for (const table of tablesToSave) {
        // Extract just the table name (without schema) for storage
        const tableNameOnly = table.includes('.') ? table.split('.')[1] : table;
        await monitoringPool.query(`
          INSERT INTO subscription_tables (
            subscription_id, table_name, schema_name, enabled
          ) VALUES ($1, $2, 'public', true)
          ON CONFLICT DO NOTHING
        `, [subscriptionId, tableNameOnly]);
      }

      res.status(201).json({
        id: subscriptionId,
        name: result.rows[0].name,
        publicationName: finalPublicationName,
        subscriptionName,
        slotName,
        tables: tablesToSave.length,
        message: 'Subscription created successfully',
      });
    } finally {
      await sourcePool.end();
      await targetPool.end();
    }
  } catch (error: any) {
    console.error('Error creating subscription:', error);
    
    // Provide more helpful error messages for common issues
    let errorMessage = error.message || 'Failed to create subscription';
    let errorDetails = error.detail || error.message;
    let hint: string | undefined;
    
    if (error.message?.includes('password authentication failed')) {
      errorMessage = 'Database authentication failed';
      errorDetails = 'The username or password in your connection string is incorrect. Please verify your database credentials.';
    } else if (error.message?.includes('connection refused') || error.message?.includes('ECONNREFUSED')) {
      errorMessage = 'Database connection refused';
      errorDetails = 'Could not connect to the database. Please verify the host, port, and that the database server is running.';
    } else if (error.message?.includes('timeout') || error.message?.includes('timeout exceeded')) {
      errorMessage = 'Database connection timeout';
      errorDetails = 'Connection to the database timed out. Please check network connectivity and firewall settings.';
      hint = 'The database may be overloaded or network connectivity is slow. Try again in a few moments.';
    } else if (error.message?.includes('all replication slots are in use') || error.message?.includes('max_replication_slots')) {
      errorMessage = 'All replication slots are in use';
      errorDetails = 'Cannot create new replication slot because all available slots are in use.';
      hint = 'Free up replication slots by dropping unused subscriptions or inactive slots. Run the free-replication-slots.sh script to check and free slots.';
    }
    
    res.status(500).json({
      error: errorMessage,
      details: errorDetails,
      ...(hint && { hint }),
    });
  }
}

