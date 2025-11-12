#!/bin/bash

# Setup script for Backup & Replication Monitoring
# This script sets up the backup monitoring dashboard

set -e

echo "========================================="
echo "Backup Monitoring Setup"
echo "========================================="
echo ""

# Check if MONITORING_DB_URL is set
if [ -z "$MONITORING_DB_URL" ]; then
    echo "❌ ERROR: MONITORING_DB_URL environment variable is not set"
    echo ""
    echo "Please set it in your .env.local file or export it:"
    echo "  export MONITORING_DB_URL='postgresql://user:pass@host:port/dbname'"
    exit 1
fi

echo "✓ MONITORING_DB_URL is set"
echo ""

# Load environment variables from .env.local if it exists
if [ -f .env.local ]; then
    echo "Loading environment variables from .env.local..."
    export $(cat .env.local | grep -v '^#' | xargs)
    echo "✓ Environment variables loaded"
    echo ""
fi

# Step 1: Run database migration
echo "Step 1: Running database migration..."
echo "----------------------------------------"
psql "$MONITORING_DB_URL" -f lib/db/migrations/003-add-backup-tracking.sql
echo "✓ Migration complete"
echo ""

# Step 2: Verify table creation
echo "Step 2: Verifying table creation..."
echo "----------------------------------------"
TABLE_EXISTS=$(psql "$MONITORING_DB_URL" -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'backup_snapshots');")
if [[ "$TABLE_EXISTS" =~ "t" ]]; then
    echo "✓ backup_snapshots table created successfully"
else
    echo "❌ ERROR: backup_snapshots table not found"
    exit 1
fi
echo ""

# Step 3: Check Backrest connectivity
echo "Step 3: Checking Backrest connectivity..."
echo "----------------------------------------"
if [ -z "$BACKREST_URL" ]; then
    echo "⚠️  WARNING: BACKREST_URL not set"
    echo "   Please set it to access Backrest API:"
    echo "   export BACKREST_URL='http://backrest:9898'"
    echo ""
    echo "   For local development with port-forward:"
    echo "   kubectl port-forward -n postgres-replication svc/backrest 9898:9898"
    echo "   export BACKREST_URL='http://localhost:9898'"
    echo ""
else
    echo "Testing connection to $BACKREST_URL..."
    if curl -k -s -f "$BACKREST_URL/v1/repos" > /dev/null 2>&1; then
        echo "✓ Backrest is accessible"
        REPO_COUNT=$(curl -k -s "$BACKREST_URL/v1/repos" | grep -o '"id"' | wc -l)
        echo "  Found $REPO_COUNT repositories"
    else
        echo "⚠️  WARNING: Cannot connect to Backrest"
        echo "   Make sure Backrest is running and accessible"
        echo "   URL: $BACKREST_URL"
    fi
fi
echo ""

# Step 4: Run initial sync
echo "Step 4: Running initial backup data sync..."
echo "----------------------------------------"
if [ -n "$BACKREST_URL" ] && curl -k -s -f "$BACKREST_URL/v1/repos" > /dev/null 2>&1; then
    echo "Syncing backup snapshots from Backrest..."
    ts-node scripts/sync-backup-status.ts
    echo ""
else
    echo "⚠️  Skipping sync (Backrest not accessible)"
    echo "   Run manually when Backrest is available:"
    echo "   ts-node scripts/sync-backup-status.ts"
    echo ""
fi

# Step 5: Show current status
echo "Step 5: Current backup status..."
echo "----------------------------------------"
psql "$MONITORING_DB_URL" -c "
SELECT 
  COUNT(*) as total_backups,
  pg_size_pretty(SUM(size_bytes)::bigint) as total_size,
  MAX(timestamp) as latest_backup
FROM backup_snapshots
WHERE status = 'completed';
"
echo ""

# Step 6: Show replication gaps
echo "Step 6: Current replication gaps..."
echo "----------------------------------------"
GAP_COUNT=$(psql "$MONITORING_DB_URL" -t -c "
SELECT COUNT(*) 
FROM table_replication_metrics 
WHERE timestamp > NOW() - INTERVAL '10 minutes' 
AND ABS(source_row_count - target_row_count) > 0;
")

if [ "$GAP_COUNT" -gt 0 ]; then
    echo "Found $GAP_COUNT tables with replication gaps"
    echo ""
    psql "$MONITORING_DB_URL" -c "
    SELECT 
      table_name,
      source_row_count,
      target_row_count,
      ABS(source_row_count - target_row_count) as gap,
      ROUND((ABS(source_row_count - target_row_count)::numeric / NULLIF(source_row_count, 0) * 100), 2) as gap_pct
    FROM table_replication_metrics 
    WHERE timestamp > NOW() - INTERVAL '10 minutes' 
    AND ABS(source_row_count - target_row_count) > 0
    ORDER BY gap DESC
    LIMIT 10;
    "
else
    echo "✓ No replication gaps found (or no recent metrics)"
fi
echo ""

echo "========================================="
echo "Setup Complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Access the dashboard:"
echo "   http://localhost:3000/backups"
echo ""
echo "2. Set up automated sync (optional):"
echo "   Add to crontab:"
echo "   */5 * * * * cd $(pwd) && ts-node scripts/sync-backup-status.ts"
echo ""
echo "   Or deploy K8s CronJob:"
echo "   kubectl apply -f k8s/backup-sync-cronjob.yaml"
echo ""
echo "3. Monitor replication progress:"
echo "   Watch the gap analysis table to see replication catching up"
echo ""
echo "4. Verify backups:"
echo "   Check the Recent Backups table for backup history"
echo ""
echo "For more information, see:"
echo "  BACKUP_MONITORING_SETUP.md"
echo ""
