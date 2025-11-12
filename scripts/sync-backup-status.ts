#!/usr/bin/env ts-node

/**
 * Sync Backup Status from Backrest
 * 
 * This script fetches backup snapshot information from Backrest API
 * and stores it in the monitoring database for dashboard display.
 * 
 * Usage:
 *   ts-node scripts/sync-backup-status.ts
 * 
 * Environment Variables:
 *   MONITORING_DB_URL - Connection string for monitoring database
 *   BACKREST_URL - URL of Backrest API (default: http://localhost:9898)
 */

import { Pool } from 'pg';

const BACKREST_URL = process.env.BACKREST_URL || 'http://localhost:9898';
const MONITORING_DB_URL = process.env.MONITORING_DB_URL;

interface BackrestSnapshot {
  id: string;
  unix_time_ms: number;
  tree: string;
  paths: string[];
  hostname: string;
  username: string;
  tags: string[];
  summary?: {
    files_new: number;
    files_changed: number;
    files_unmodified: number;
    dirs_new: number;
    dirs_changed: number;
    dirs_unmodified: number;
    data_blobs: number;
    tree_blobs: number;
    data_added: number;
    total_files_processed: number;
    total_bytes_processed: number;
    total_duration: number;
  };
}

interface BackrestRepo {
  id: string;
  uri: string;
  password: string;
}

async function fetchBackrestSnapshots(repoId: string): Promise<BackrestSnapshot[]> {
  try {
    const https = require('https');
    const nodeFetch = require('node-fetch');
    const agent = new https.Agent({ rejectUnauthorized: false });
    
    const response = await nodeFetch(`${BACKREST_URL}/v1/repos/${repoId}/snapshots`, { agent });
    if (!response.ok) {
      throw new Error(`Failed to fetch snapshots: ${response.statusText}`);
    }
    const data = await response.json();
    return data.snapshots || [];
  } catch (error: any) {
    console.error(`Error fetching snapshots for repo ${repoId}:`, error.message);
    return [];
  }
}

async function fetchBackrestRepos(): Promise<BackrestRepo[]> {
  try {
    const https = require('https');
    const nodeFetch = require('node-fetch');
    const agent = new https.Agent({ rejectUnauthorized: false });
    
    const response = await nodeFetch(`${BACKREST_URL}/v1/repos`, { agent });
    if (!response.ok) {
      throw new Error(`Failed to fetch repos: ${response.statusText}`);
    }
    const data = await response.json();
    return data.repos || [];
  } catch (error: any) {
    console.error('Error fetching repos:', error.message);
    return [];
  }
}

async function syncBackupStatus() {
  if (!MONITORING_DB_URL) {
    console.error('ERROR: MONITORING_DB_URL environment variable not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: MONITORING_DB_URL });

  try {
    console.log('Connecting to monitoring database...');
    await pool.query('SELECT 1');
    console.log('✓ Connected to monitoring database');

    console.log(`Fetching repos from Backrest at ${BACKREST_URL}...`);
    const repos = await fetchBackrestRepos();
    console.log(`✓ Found ${repos.length} repositories`);

    let totalSynced = 0;

    for (const repo of repos) {
      console.log(`\nProcessing repository: ${repo.id}`);
      
      const snapshots = await fetchBackrestSnapshots(repo.id);
      console.log(`  Found ${snapshots.length} snapshots`);

      for (const snapshot of snapshots) {
        try {
          const timestamp = new Date(snapshot.unix_time_ms);
          const sizeBytes = snapshot.summary?.data_added || 0;
          const durationSeconds = snapshot.summary?.total_duration || 0;

          // Insert or update snapshot
          await pool.query(`
            INSERT INTO backup_snapshots (
              snapshot_id,
              timestamp,
              size_bytes,
              duration,
              status,
              repository,
              metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (snapshot_id) DO UPDATE SET
              timestamp = EXCLUDED.timestamp,
              size_bytes = EXCLUDED.size_bytes,
              duration = EXCLUDED.duration,
              status = EXCLUDED.status,
              metadata = EXCLUDED.metadata
          `, [
            snapshot.id,
            timestamp,
            sizeBytes,
            `${durationSeconds} seconds`,
            'completed',
            repo.id,
            JSON.stringify(snapshot.summary || {})
          ]);

          totalSynced++;
        } catch (error: any) {
          console.error(`  Error syncing snapshot ${snapshot.id}:`, error.message);
        }
      }
    }

    console.log(`\n✓ Sync complete! Synced ${totalSynced} snapshots`);

    // Show summary
    const summary = await pool.query(`
      SELECT 
        COUNT(*) as total_backups,
        SUM(size_bytes) as total_size,
        MAX(timestamp) as latest_backup
      FROM backup_snapshots
      WHERE status = 'completed'
    `);

    if (summary.rows.length > 0) {
      const row = summary.rows[0];
      console.log('\nBackup Summary:');
      console.log(`  Total backups: ${row.total_backups}`);
      console.log(`  Total size: ${formatBytes(row.total_size || 0)}`);
      console.log(`  Latest backup: ${row.latest_backup || 'N/A'}`);
    }

  } catch (error: any) {
    console.error('ERROR:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// Run the sync
syncBackupStatus().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
