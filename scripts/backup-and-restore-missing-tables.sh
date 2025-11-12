#!/bin/bash
set -euo pipefail

# Automatically backup and restore missing tables from AWS to GCP
# This fixes the issue where tables in publication don't exist on target

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
PUBLICATION="reya_replication"
SUBSCRIPTION="reya_subscription"
OUTPUT_DIR="./schema-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "========================================="
echo "Backup and Restore Missing Tables"
echo "========================================="
echo ""

# Get credentials
SOURCE_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.source-database-url}' | base64 -d)
DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)

SOURCE_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$SOURCE_URL').hostname)")
SOURCE_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$SOURCE_URL'); print(url.port or 5432)")
SOURCE_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$SOURCE_URL'); print(unquote(url.username or ''))")
SOURCE_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$SOURCE_URL'); print(unquote(url.password or ''))")
SOURCE_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$SOURCE_URL'); print(url.path.lstrip('/'))")

DEST_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$DEST_URL').hostname)")
DEST_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.port or 5432)")
DEST_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.username or ''))")
DEST_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.password or ''))")
DEST_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.path.lstrip('/'))")

echo "Source (RDS):  ${SOURCE_HOST}:${SOURCE_PORT}/${SOURCE_DB}"
echo "Dest (Cloud):  ${DEST_HOST}:${DEST_PORT}/${DEST_DB}"
echo ""

# Step 1: Find missing tables
echo "Step 1: Finding missing tables on target..."
MISSING_TABLES=""

PUB_TABLES=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT schemaname || '.' || tablename
  FROM pg_publication_tables
  WHERE pubname = '$PUBLICATION'
  ORDER BY schemaname, tablename;
" 2>/dev/null || echo "")

while IFS= read -r table_full; do
  if [[ -z "$table_full" ]]; then continue; fi
  IFS='.' read -r schema table <<< "$table_full"
  
  EXISTS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = '$schema' AND table_name = '$table';
  " 2>/dev/null || echo "0")
  
  if [[ "$EXISTS" == "0" ]]; then
    MISSING_TABLES="${MISSING_TABLES}${table_full}"$'\n'
    echo "  ❌ $table_full"
  fi
done <<< "$PUB_TABLES"

if [[ -z "$MISSING_TABLES" ]]; then
  echo "✓ No missing tables - all tables in publication exist on target"
  echo ""
  echo "========================================="
  echo "✓ Done"
  echo "========================================="
  exit 0
fi

MISSING_COUNT=$(echo "$MISSING_TABLES" | grep -c . || echo "0")
echo ""
echo "Found $MISSING_COUNT missing table(s)"
echo ""

# Step 2: Backup schema for missing tables
echo "Step 2: Backing up schema for missing tables..."
mkdir -p "$OUTPUT_DIR"

OUTPUT_FILE="${OUTPUT_DIR}/schema_${TIMESTAMP}_missing.sql"

# Build table list for pg_dump
TABLE_ARGS=""
TABLE_LIST=""
while IFS= read -r table_full; do
  if [[ -n "$table_full" ]]; then
    TABLE_ARGS="${TABLE_ARGS} -t ${table_full}"
    TABLE_LIST="${TABLE_LIST}${table_full} "
  fi
done <<< "$MISSING_TABLES"

echo "Backing up: $TABLE_LIST"
echo ""

PGPASSWORD="$SOURCE_PASS" pg_dump \
  -h "$SOURCE_HOST" \
  -p "$SOURCE_PORT" \
  -U "$SOURCE_USER" \
  -d "$SOURCE_DB" \
  --schema-only \
  --no-owner \
  --no-privileges \
  $TABLE_ARGS \
  -f "$OUTPUT_FILE" 2>&1 | grep -v "NOTICE" || true

if [[ ! -f "$OUTPUT_FILE" ]] || [[ ! -s "$OUTPUT_FILE" ]]; then
  echo "❌ Backup failed or file is empty"
  exit 1
fi

SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo "✓ Schema backup created: $OUTPUT_FILE ($SIZE)"
echo ""

# Step 3: Restore schema to target
echo "Step 3: Restoring schema to Cloud SQL..."
echo ""

PGPASSWORD="$DEST_PASS" psql \
  -h "$DEST_HOST" \
  -p "$DEST_PORT" \
  -U "$DEST_USER" \
  -d "$DEST_DB" \
  -f "$OUTPUT_FILE" \
  2>&1 | grep -v "NOTICE" || true

if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
  echo "⚠️  Schema restore completed with warnings/errors"
  echo "Check the output above for details"
fi

echo ""

# Step 4: Verify tables were created
echo "Step 4: Verifying restored tables..."
RESTORED_COUNT=0
FAILED_TABLES=""

while IFS= read -r table_full; do
  if [[ -z "$table_full" ]]; then continue; fi
  IFS='.' read -r schema table <<< "$table_full"
  
  EXISTS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = '$schema' AND table_name = '$table';
  " 2>/dev/null || echo "0")
  
  if [[ "$EXISTS" == "1" ]]; then
    RESTORED_COUNT=$((RESTORED_COUNT + 1))
    echo "  ✓ $table_full"
  else
    FAILED_TABLES="${FAILED_TABLES}${table_full}"$'\n'
    echo "  ❌ $table_full (failed to create)"
  fi
done <<< "$MISSING_TABLES"

echo ""

# Step 5: Refresh subscription
if [[ $RESTORED_COUNT -gt 0 ]]; then
  echo "Step 5: Refreshing subscription to include new tables..."
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
    ALTER SUBSCRIPTION $SUBSCRIPTION REFRESH PUBLICATION;
  " 2>&1 | grep -v "NOTICE" || echo "✓ Subscription refreshed"
  echo ""
fi

# Summary
echo "========================================="
echo "Summary"
echo "========================================="
echo "Missing tables found: $MISSING_COUNT"
echo "Tables restored: $RESTORED_COUNT"
if [[ -n "$FAILED_TABLES" ]]; then
  echo ""
  echo "Failed to restore:"
  echo "$FAILED_TABLES" | while read -r table; do
    if [[ -n "$table" ]]; then
      echo "  - $table"
    fi
  done
fi
echo ""
echo "Backup file: $OUTPUT_FILE"
echo ""

if [[ $RESTORED_COUNT -eq $MISSING_COUNT ]]; then
  echo "✓ All missing tables restored successfully"
  echo ""
  echo "Next steps:"
  echo "  1. Check replication status: ./scripts/check-and-enable-replication.sh"
  echo "  2. Monitor replication: cd ../migration && ./monitor-replication.sh"
else
  echo "⚠️  Some tables failed to restore. Check errors above."
fi

echo ""
echo "========================================="

