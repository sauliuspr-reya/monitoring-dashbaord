#!/usr/bin/env node

/**
 * Start a verification job for the test_orders table
 */

const { config } = require('dotenv');
const { Pool } = require('pg');

config();

async function startVerification() {
  const pool = new Pool({
    host: process.env.MONITORING_DB_HOST,
    port: parseInt(process.env.MONITORING_DB_PORT || '5432'),
    database: process.env.MONITORING_DB_NAME,
    user: process.env.MONITORING_DB_USER,
    password: process.env.MONITORING_DB_PASSWORD,
  });

  try {
    console.log('Starting verification job for test_orders...');
    
    // Check if job already exists
    const existingJob = await pool.query(
      `SELECT * FROM table_verification_jobs WHERE table_name = 'test_orders' AND status = 'running'`
    );

    if (existingJob.rows.length > 0) {
      console.log('✓ Job already running:', existingJob.rows[0]);
      return;
    }

    // Detect primary key from source database
    const sourcePool = new Pool({ connectionString: process.env.SOURCE_DATABASE_URL });
    const pkQuery = `
      SELECT a.attname as column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'test_orders'::regclass AND i.indisprimary
    `;
    const pkResult = await sourcePool.query(pkQuery);
    const primaryKey = pkResult.rows[0]?.column_name || 'id';
    await sourcePool.end();

    console.log(`Detected primary key: ${primaryKey}`);

    // Create verification job
    const result = await pool.query(
      `INSERT INTO table_verification_jobs 
       (table_name, status, batch_size, cooldown_ms, primary_key_column)
       VALUES ($1, 'running', $2, $3, $4)
       RETURNING *`,
      ['test_orders', 1000, 100, primaryKey]
    );

    console.log('✓ Verification job created:');
    console.log(`  Job ID: ${result.rows[0].id}`);
    console.log(`  Table: ${result.rows[0].table_name}`);
    console.log(`  Primary Key: ${result.rows[0].primary_key_column}`);
    console.log(`  Batch Size: ${result.rows[0].batch_size}`);
    console.log(`  Cooldown: ${result.rows[0].cooldown_ms}ms`);
    console.log('');
    console.log('The verification worker should now pick up this job!');
    console.log('Watch the worker logs to see progress.');
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

startVerification();
