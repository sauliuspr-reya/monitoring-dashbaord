import type { NextApiRequest, NextApiResponse } from 'next';
import { createSourceTargetPool } from '@/lib/db/connection';

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
      tables,
      allTables = false,
      sourceDbConnection,
      insertEnabled = true,
      updateEnabled = true,
      deleteEnabled = true,
      truncateEnabled = false,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: 'Publication name is required',
      });
    }

    if (!allTables && (!tables || !Array.isArray(tables) || tables.length === 0)) {
      return res.status(400).json({
        error: 'Either allTables must be true or tables array must be provided',
      });
    }

    // Use provided connection or fall back to environment variable
    const finalSourceConnection = (sourceDbConnection && sourceDbConnection.trim() !== '') 
      ? sourceDbConnection 
      : (process.env.SOURCE_DATABASE_URL || '');

    if (!finalSourceConnection || finalSourceConnection.trim() === '') {
      return res.status(400).json({
        error: 'Source database connection string is required',
        details: 'Please set SOURCE_DATABASE_URL environment variable or provide sourceDbConnection.',
      });
    }

    const sourcePool = createSourceTargetPool(finalSourceConnection);

    try {
      // Check if publication already exists
      const pubCheck = await sourcePool.query(`
        SELECT COUNT(*) as count FROM pg_publication WHERE pubname = $1
      `, [name]);

      if (pubCheck.rows[0].count !== '0') {
        await sourcePool.end();
        return res.status(409).json({
          error: 'Publication already exists',
          details: `Publication '${name}' already exists on source database.`,
        });
      }

      // Escape publication name
      const escapedPubName = `"${name.replace(/"/g, '""')}"`;

      if (allTables) {
        // Create publication for all tables
        await sourcePool.query(`
          CREATE PUBLICATION ${escapedPubName} FOR ALL TABLES
        `);
      } else {
        // Create publication for specific tables
        const tableList = tables.map((t: string) => {
          const escaped = t.replace(/"/g, '""');
          return `"${escaped}"`;
        }).join(', ');
        
        await sourcePool.query(`
          CREATE PUBLICATION ${escapedPubName} FOR TABLE ${tableList}
        `);
      }

      // Get the created publication details
      const pubResult = await sourcePool.query(`
        SELECT 
          pubname AS name,
          puballtables AS all_tables,
          pubinsert AS insert_enabled,
          pubupdate AS update_enabled,
          pubdelete AS delete_enabled,
          pubtruncate AS truncate_enabled
        FROM pg_publication
        WHERE pubname = $1
      `, [name]);

      // Get tables in the publication
      let tablesList: string[] = [];
      if (pubResult.rows[0].all_tables) {
        const allTablesResult = await sourcePool.query(`
          SELECT schemaname || '.' || tablename AS table_name
          FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY schemaname, tablename
        `);
        tablesList = allTablesResult.rows.map((r: any) => r.table_name);
      } else {
        const tablesResult = await sourcePool.query(`
          SELECT schemaname || '.' || tablename AS table_name
          FROM pg_publication_tables
          WHERE pubname = $1
          ORDER BY schemaname, tablename
        `, [name]);
        tablesList = tablesResult.rows.map((r: any) => r.table_name);
      }

      res.status(201).json({
        success: true,
        publication: {
          name: pubResult.rows[0].name,
          allTables: pubResult.rows[0].all_tables,
          insertEnabled: pubResult.rows[0].insert_enabled,
          updateEnabled: pubResult.rows[0].update_enabled,
          deleteEnabled: pubResult.rows[0].delete_enabled,
          truncateEnabled: pubResult.rows[0].truncate_enabled,
          tables: tablesList,
          tableCount: tablesList.length,
        },
      });
    } finally {
      await sourcePool.end();
    }
  } catch (error: any) {
    console.error('[publications/create] Error:', error);
    res.status(500).json({
      error: 'Failed to create publication',
      message: error.message,
      details: error.detail || error.message,
    });
  }
}

