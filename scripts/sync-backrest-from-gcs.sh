#!/bin/bash

# Sync Backup Status from GCS/Restic
# This script queries restic directly to get backup snapshots
# and stores them in the monitoring database

set -e

echo "========================================="
echo "Sync Backrest Snapshots from GCS"
echo "========================================="
echo ""

# Check required environment variables
if [ -z "$MONITORING_DB_URL" ]; then
    echo "❌ ERROR: MONITORING_DB_URL not set"
    exit 1
fi

if [ -z "$RESTIC_REPOSITORY" ]; then
    echo "❌ ERROR: RESTIC_REPOSITORY not set"
    echo "   Example: export RESTIC_REPOSITORY='gs:reya-mainnet-sql-backup:/backrest/'"
    exit 1
fi

if [ -z "$RESTIC_PASSWORD" ]; then
    echo "❌ ERROR: RESTIC_PASSWORD not set"
    exit 1
fi

echo "Repository: $RESTIC_REPOSITORY"
echo ""

# Get snapshots from restic
echo "Fetching snapshots from restic..."
SNAPSHOTS=$(restic snapshots --json 2>/dev/null || echo "[]")

if [ "$SNAPSHOTS" = "[]" ]; then
    echo "⚠️  No snapshots found or restic command failed"
    echo "   Make sure restic is installed and credentials are correct"
    exit 1
fi

# Count snapshots
SNAPSHOT_COUNT=$(echo "$SNAPSHOTS" | jq '. | length')
echo "✓ Found $SNAPSHOT_COUNT snapshots"
echo ""

# Parse and insert each snapshot
echo "Syncing snapshots to monitoring database..."
echo "$SNAPSHOTS" | jq -c '.[]' | while read -r snapshot; do
    SNAPSHOT_ID=$(echo "$snapshot" | jq -r '.short_id')
    TIMESTAMP=$(echo "$snapshot" | jq -r '.time')
    
    # Get snapshot stats
    STATS=$(restic stats "$SNAPSHOT_ID" --json 2>/dev/null || echo "{}")
    SIZE_BYTES=$(echo "$STATS" | jq -r '.total_size // 0')
    
    # Calculate duration (approximate from snapshot metadata)
    # Note: Restic doesn't store duration, so we'll set it to NULL
    
    echo "  Syncing snapshot $SNAPSHOT_ID..."
    
    # Insert into database
    psql "$MONITORING_DB_URL" -c "
        INSERT INTO backup_snapshots (
            snapshot_id,
            timestamp,
            size_bytes,
            status,
            repository,
            backup_type
        ) VALUES (
            '$SNAPSHOT_ID',
            '$TIMESTAMP',
            $SIZE_BYTES,
            'completed',
            'postgres-rds',
            'full'
        )
        ON CONFLICT (snapshot_id) DO UPDATE SET
            timestamp = EXCLUDED.timestamp,
            size_bytes = EXCLUDED.size_bytes,
            status = EXCLUDED.status;
    " > /dev/null 2>&1
done

echo ""
echo "✓ Sync complete!"
echo ""

# Show summary
psql "$MONITORING_DB_URL" -c "
SELECT 
    COUNT(*) as total_backups,
    pg_size_pretty(SUM(size_bytes)::bigint) as total_size,
    MAX(timestamp) as latest_backup,
    MIN(timestamp) as oldest_backup
FROM backup_snapshots
WHERE repository = 'postgres-rds';
"

echo ""
echo "========================================="
