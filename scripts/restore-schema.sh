#!/bin/bash
set -euo pipefail

# Restore schema from backup file to GCP Cloud SQL
# Can restore all or specific tables

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <schema-backup-file> [--dry-run]"
  echo ""
  echo "Example:"
  echo "  $0 ./schema-backups/schema_20241107_120000_all.sql"
  echo "  $0 ./schema-backups/schema_20241107_120000_tables.sql --dry-run"
  exit 1
fi

SCHEMA_FILE="$1"
DRY_RUN="${2:-}"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "❌ Error: Schema file not found: $SCHEMA_FILE"
  exit 1
fi

echo "========================================="
echo "Restore Schema to GCP Cloud SQL"
echo "========================================="
echo ""

# Get credentials
if ! kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "❌ Error: Secret not found"
  exit 1
fi

DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.target-database-url}' | base64 -d)

DEST_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$DEST_URL').hostname)")
DEST_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.port or 5432)")
DEST_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.username or ''))")
DEST_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.password or ''))")
DEST_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.path.lstrip('/'))")

echo "Dest (Cloud):  ${DEST_HOST}:${DEST_PORT}/${DEST_DB}"
echo "Schema file:   $SCHEMA_FILE"
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "Mode:          DRY RUN (no changes will be made)"
fi
echo ""

# Extract table names from schema file
TABLES_IN_FILE=$(grep -E "^CREATE TABLE|^CREATE UNLOGGED TABLE" "$SCHEMA_FILE" | \
  sed -E 's/^CREATE (UNLOGGED )?TABLE (IF NOT EXISTS )?([^ (]+).*/\3/' | \
  sed 's/"//g' | sort -u)

if [[ -z "$TABLES_IN_FILE" ]]; then
  echo "⚠️  No CREATE TABLE statements found in schema file"
else
  echo "Tables in schema file:"
  echo "$TABLES_IN_FILE" | while read -r table; do
    if [[ -n "$table" ]]; then
      # Check if table exists on target
      EXISTS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
        SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '$table';
      " 2>/dev/null || echo "0")
      
      if [[ "$EXISTS" == "1" ]]; then
        echo "  ⚠️  $table (already exists - will be skipped or replaced)"
      else
        echo "  ✓ $table (will be created)"
      fi
    fi
  done
fi

echo ""

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "DRY RUN: Would restore schema from $SCHEMA_FILE"
  echo "To actually restore, run without --dry-run flag"
  exit 0
fi

# Confirm
read -p "Restore schema to Cloud SQL? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

echo ""
echo "Restoring schema..."

# Restore schema
PGPASSWORD="$DEST_PASS" psql \
  -h "$DEST_HOST" \
  -p "$DEST_PORT" \
  -U "$DEST_USER" \
  -d "$DEST_DB" \
  -f "$SCHEMA_FILE" \
  2>&1 | grep -v "NOTICE" || true

if [[ ${PIPESTATUS[0]} -eq 0 ]]; then
  echo "✓ Schema restored"
  
  # Verify tables were created
  echo ""
  echo "Verifying restored tables..."
  CREATED_COUNT=0
  echo "$TABLES_IN_FILE" | while read -r table; do
    if [[ -n "$table" ]]; then
      EXISTS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
        SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '$table';
      " 2>/dev/null || echo "0")
      
      if [[ "$EXISTS" == "1" ]]; then
        CREATED_COUNT=$((CREATED_COUNT + 1))
        echo "  ✓ $table"
      else
        echo "  ❌ $table (failed to create)"
      fi
    fi
  done
else
  echo "⚠️  Schema restore completed with warnings/errors"
  echo "Check the output above for details"
fi

echo ""
echo "========================================="
echo "✓ Done"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Refresh subscription: ALTER SUBSCRIPTION reya_subscription REFRESH PUBLICATION;"
echo "  2. Check replication status: ./scripts/check-and-enable-replication.sh"

