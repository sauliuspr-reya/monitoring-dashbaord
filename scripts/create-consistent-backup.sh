#!/bin/bash
set -euo pipefail

# ============================================
# Create Consistent Backup with Replication Slot
# ============================================
# This script:
# 1. Connects to the source database in REPLICATION mode
# 2. Creates a replication slot and EXPORTS a snapshot
# 3. Runs pg_dump using that snapshot
# 4. Ensures zero data gaps and zero duplicates

# Configuration
SOURCE_HOST="${SOURCE_HOST:-localhost}"
SOURCE_PORT="${SOURCE_PORT:-5432}"
SOURCE_USER="${SOURCE_USER:-postgres}"
SOURCE_DB="${SOURCE_DB:-reya}"
OUTPUT_DIR="${OUTPUT_DIR:-./backups}"
TIMESTAMP=$(date +%s%3N)
SLOT_NAME="backup_slot_${TIMESTAMP}"
# Note: Publication must be created separately or exist already
# We assume the publication 'backup_pub' or similar exists or will be created for the tables.

mkdir -p "$OUTPUT_DIR"
DUMP_FILE="${OUTPUT_DIR}/backup_${TIMESTAMP}.dump"

echo "========================================="
echo "Creating Consistent Backup"
echo "========================================="
echo "Source: $SOURCE_HOST:$SOURCE_PORT/$SOURCE_DB"
echo "Slot:   $SLOT_NAME"
echo "Output: $DUMP_FILE"
echo ""

# We need to keep the psql replication session open while pg_dump runs.
# We use a coprocess to handle the interactive replication protocol session.

PIPE=$(mktemp -u)
mkfifo "$PIPE"

echo "Connecting in replication mode to create slot..."

# Start psql in replication mode
# We use 'script' or similar if needed, but standard piping should work for simple input/output
# Note: replication=database connection
coproc PSQL_PROC { PGPASSWORD="$SOURCE_PASS" psql "host=$SOURCE_HOST port=$SOURCE_PORT user=$SOURCE_USER dbname=$SOURCE_DB replication=database" -t -A; }

# Send Create Slot command with SNAPSHOT export
# Syntax: CREATE_REPLICATION_SLOT slot_name LOGICAL pgoutput SNAPSHOT 'export'
echo "CREATE_REPLICATION_SLOT $SLOT_NAME LOGICAL pgoutput SNAPSHOT 'export';" >&"${PSQL_PROC[1]}"

# Read output
# Format: slot_name|consistent_point|snapshot_name|output_plugin
read -r SLOT_OUTPUT <&"${PSQL_PROC[0]}"

if [[ -z "$SLOT_OUTPUT" ]]; then
  echo "❌ Failed to create slot or get output"
  exit 1
fi

# Parse output (pipe delimited because of -t -A? No, replication commands output might differ)
# Actually, CREATE_REPLICATION_SLOT returns a result set.
# With -t -A -F"|", it should be delimited.

IFS='|' read -r CREATED_SLOT_NAME CONSISTENT_POINT SNAPSHOT_NAME PLUGIN <<< "$SLOT_OUTPUT"

echo "✓ Slot created: $CREATED_SLOT_NAME"
echo "✓ Snapshot ID:  $SNAPSHOT_NAME"
echo "✓ LSN:          $CONSISTENT_POINT"
echo ""

if [[ -z "$SNAPSHOT_NAME" ]]; then
  echo "❌ No snapshot ID returned. Check if your Postgres version supports SNAPSHOT 'export'."
  exit 1
fi

# Now run pg_dump with the snapshot
echo "Running pg_dump with snapshot $SNAPSHOT_NAME..."
PGPASSWORD="$SOURCE_PASS" pg_dump \
  -h "$SOURCE_HOST" \
  -p "$SOURCE_PORT" \
  -U "$SOURCE_USER" \
  -d "$SOURCE_DB" \
  --snapshot="$SNAPSHOT_NAME" \
  -F c \
  -f "$DUMP_FILE" \
  --verbose

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "✓ Backup completed successfully"
else
  echo "❌ Backup failed"
fi

# Close the replication connection
echo "exit" >&"${PSQL_PROC[1]}"

# Clean up
rm "$PIPE"

echo ""
echo "========================================="
echo "Next Steps:"
echo "1. Restore: ./scripts/restore-to-gcp.sh $DUMP_FILE"
echo "2. Create Subscription using slot: $SLOT_NAME"
echo "   (Ensure create_slot=false, copy_data=false)"
echo "========================================="
