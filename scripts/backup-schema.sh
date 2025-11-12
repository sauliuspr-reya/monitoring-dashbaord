#!/bin/bash
set -euo pipefail

# Backup schema from AWS RDS to a file
# Can backup all tables or specific tables

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
OUTPUT_DIR="${OUTPUT_DIR:-./schema-backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "========================================="
echo "Backup Schema from AWS RDS"
echo "========================================="
echo ""

# Get credentials
if ! kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "❌ Error: Secret not found"
  exit 1
fi

SOURCE_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.source-database-url}' | base64 -d)

SOURCE_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$SOURCE_URL').hostname)")
SOURCE_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$SOURCE_URL'); print(url.port or 5432)")
SOURCE_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$SOURCE_URL'); print(unquote(url.username or ''))")
SOURCE_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$SOURCE_URL'); print(unquote(url.password or ''))")
SOURCE_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$SOURCE_URL'); print(url.path.lstrip('/'))")

echo "Source (RDS):  ${SOURCE_HOST}:${SOURCE_PORT}/${SOURCE_DB}"
echo "Output dir:    ${OUTPUT_DIR}"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Check if specific tables provided
if [[ $# -gt 0 ]]; then
  TABLES="$@"
  echo "Backing up specific tables: $TABLES"
  OUTPUT_FILE="${OUTPUT_DIR}/schema_${TIMESTAMP}_tables.sql"
  
  # Build table list for pg_dump
  TABLE_ARGS=""
  for table in $TABLES; do
    TABLE_ARGS="${TABLE_ARGS} -t ${table}"
  done
  
  echo "Running pg_dump (schema only)..."
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
    
else
  echo "Backing up all schemas..."
  OUTPUT_FILE="${OUTPUT_DIR}/schema_${TIMESTAMP}_all.sql"
  
  echo "Running pg_dump (schema only, all tables)..."
  PGPASSWORD="$SOURCE_PASS" pg_dump \
    -h "$SOURCE_HOST" \
    -p "$SOURCE_PORT" \
    -U "$SOURCE_USER" \
    -d "$SOURCE_DB" \
    --schema-only \
    --no-owner \
    --no-privileges \
    -f "$OUTPUT_FILE" 2>&1 | grep -v "NOTICE" || true
fi

if [[ -f "$OUTPUT_FILE" ]]; then
  SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
  echo "✓ Schema backup created: $OUTPUT_FILE ($SIZE)"
  echo ""
  echo "To restore:"
  echo "  ./restore-schema.sh $OUTPUT_FILE"
else
  echo "❌ Backup failed"
  exit 1
fi

echo ""
echo "========================================="
echo "✓ Done"
echo "========================================="

