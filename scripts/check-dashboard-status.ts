#!/usr/bin/env ts-node

/**
 * Check Dashboard Status
 * 
 * This script checks the monitoring dashboard's database to see:
 * - How many subscriptions are tracked
 * - Connection status
 * - Why tables might not be showing
 */

import { Pool } from 'pg';

interface PoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

async function main() {
  console.log('==========================================');
  console.log('Dashboard Status Check');
  console.log('==========================================\n');

  // Get monitoring database connection from environment
  const password = (process.env.MONITORING_DB_PASSWORD || '').replace(/^['"]|['"]$/g, '');
  
  const config: PoolConfig = {
    host: process.env.MONITORING_DB_HOST || 'localhost',
    port: parseInt(process.env.MONITORING_DB_PORT || '5432'),
    database: process.env.MONITORING_DB_NAME || 'replication_monitoring',
    user: process.env.MONITORING_DB_USER || 'postgres',
    password: password,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  console.log('Monitoring Database Config:');
  console.log(`  Host: ${config.host}`);
  console.log(`  Port: ${config.port}`);
  console.log(`  Database: ${config.database}`);
  console.log(`  User: ${config.user}`);
  console.log(`  Password: ${password ? '***' : '(not set)'}\n`);

  if (!password) {
    console.log('❌ MONITORING_DB_PASSWORD not set!\n');
    console.log('Set environment variables in .env.local:');
    console.log('  MONITORING_DB_HOST=...');
    console.log('  MONITORING_DB_PORT=5432');
    console.log('  MONITORING_DB_NAME=replication_monitoring');
    console.log('  MONITORING_DB_USER=postgres');
    console.log('  MONITORING_DB_PASSWORD=...\n');
    process.exit(1);
  }

  const pool = new Pool(config);

  try {
    // Test connection
    console.log('Testing connection...');
    await pool.query('SELECT 1');
    console.log('✓ Connected to monitoring database\n');

    // Check if subscriptions table exists
    console.log('Checking schema...');
    const tableCheckResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('subscriptions', 'replication_groups')
      ORDER BY table_name;
    `);

    if (tableCheckResult.rows.length === 0) {
      console.log('❌ Schema tables not found!\n');
      console.log('Run the schema setup:');
      console.log('  psql -h', config.host, '-U', config.user, '-d', config.database, '< lib/db/schema.sql\n');
      await pool.end();
      process.exit(1);
    }

    const tableName = tableCheckResult.rows.find(r => r.table_name === 'subscriptions')?.table_name || 'replication_groups';
    console.log(`✓ Using table: ${tableName}\n`);

    // Check subscriptions
    console.log('==========================================');
    console.log('Subscriptions in Dashboard');
    console.log('==========================================\n');

    const subsResult = await pool.query(`
      SELECT 
        id,
        name,
        publication_name,
        subscription_name,
        enabled,
        created_at
      FROM ${tableName}
      ORDER BY created_at DESC;
    `);

    if (subsResult.rows.length === 0) {
      console.log('❌ NO SUBSCRIPTIONS FOUND in monitoring database!\n');
      console.log('This is why the dashboard shows no tables.\n');
      console.log('To fix this, you need to add a subscription to the dashboard.\n');
      console.log('Options:\n');
      console.log('1. Use the dashboard UI:');
      console.log('   - Go to http://localhost:3002/subscriptions/new');
      console.log('   - Fill in subscription details');
      console.log('   - Click "Create Subscription"\n');
      console.log('2. Use the import script:');
      console.log('   - Run: ./scripts/import-subscription-to-dashboard.sh\n');
      console.log('3. Manual SQL:');
      console.log(`   INSERT INTO ${tableName} (`);
      console.log('     name, publication_name, subscription_name, slot_name,');
      console.log('     source_db_connection, target_db_connection, enabled');
      console.log('   ) VALUES (');
      console.log("     'Main Replication', 'reya_publication', 'reya_subscription', 'reya_subscription',");
      console.log("     'postgresql://postgres:PASSWORD@RDS_HOST:5432/reya',");
      console.log("     'postgresql://postgres:PASSWORD@GCP_HOST:5432/reya',");
      console.log('     true');
      console.log('   );\n');
    } else {
      console.log(`✓ Found ${subsResult.rows.length} subscription(s):\n`);
      
      for (const sub of subsResult.rows) {
        console.log(`  Name: ${sub.name}`);
        console.log(`  ID: ${sub.id}`);
        console.log(`  Publication: ${sub.publication_name}`);
        console.log(`  Subscription: ${sub.subscription_name}`);
        console.log(`  Enabled: ${sub.enabled}`);
        console.log(`  Created: ${sub.created_at}`);
        console.log('');
      }

      // Check if connections are set
      const connCheckResult = await pool.query(`
        SELECT 
          id,
          name,
          LENGTH(source_db_connection) as source_len,
          LENGTH(target_db_connection) as target_len
        FROM ${tableName};
      `);

      console.log('Connection Strings Status:');
      for (const row of connCheckResult.rows) {
        console.log(`  ${row.name}:`);
        console.log(`    Source: ${row.source_len > 0 ? '✓ Set (' + row.source_len + ' chars)' : '❌ Empty'}`);
        console.log(`    Target: ${row.target_len > 0 ? '✓ Set (' + row.target_len + ' chars)' : '❌ Empty'}`);
      }
      console.log('');

      // Check recent metrics
      console.log('==========================================');
      console.log('Recent Metrics');
      console.log('==========================================\n');

      const metricsCheckResult = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name = 'table_replication_metrics'
        LIMIT 1;
      `);

      if (metricsCheckResult.rows.length > 0) {
        const metricsResult = await pool.query(`
          SELECT 
            COUNT(*) as total_metrics,
            COUNT(DISTINCT table_name) as unique_tables,
            MAX(timestamp) as latest_metric
          FROM table_replication_metrics;
        `);

        if (metricsResult.rows[0].total_metrics > 0) {
          console.log(`✓ Metrics collected:`);
          console.log(`  Total metrics: ${metricsResult.rows[0].total_metrics}`);
          console.log(`  Unique tables: ${metricsResult.rows[0].unique_tables}`);
          console.log(`  Latest: ${metricsResult.rows[0].latest_metric}`);
          console.log('');
        } else {
          console.log('⚠️  No metrics collected yet');
          console.log('   Metrics are collected when you visit the dashboard\n');
        }
      }
    }

    // Final recommendations
    console.log('==========================================');
    console.log('Status Summary');
    console.log('==========================================\n');

    if (subsResult.rows.length === 0) {
      console.log('❌ Dashboard has NO subscriptions');
      console.log('   → Add a subscription to see tables\n');
      console.log('Next steps:');
      console.log('  1. Make sure PostgreSQL logical replication is set up (on RDS → GCP)');
      console.log('  2. Add the subscription to the dashboard using one of the methods above');
      console.log('  3. Refresh the dashboard at http://localhost:3002\n');
    } else {
      console.log('✓ Dashboard is configured with subscriptions');
      console.log('\nIf you still don\'t see tables:');
      console.log('  1. Make sure the PostgreSQL subscription exists on GCP:');
      console.log('     SELECT * FROM pg_subscription;');
      console.log('  2. Make sure the publication has tables on RDS:');
      console.log('     SELECT * FROM pg_publication_tables WHERE pubname = \'reya_publication\';');
      console.log('  3. Refresh the dashboard in your browser (Ctrl+Shift+R)');
      console.log('  4. Check browser console for errors (F12)\n');
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error('\nFailed to connect to monitoring database.');
    console.error('Check your .env.local configuration.\n');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);

