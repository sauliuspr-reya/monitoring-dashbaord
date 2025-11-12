#!/bin/bash
set -euo pipefail

# Find tables in publication that don't exist on target
# This helps identify why replication is failing

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
PUBLICATION="reya_replication"

echo "========================================="
echo "Finding Missing Tables"
echo "========================================="
echo ""

# Get credentials
SOURCE_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.source-database-url}' | base64 -d)
DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)

SOURCE_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$SOURCE_URL').hostname)")
SOURCE_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$SOURCE_URL'); print(unquote(url.username or ''))")
SOURCE_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$SOURCE_URL'); print(unquote(url.password or ''))")
SOURCE_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$SOURCE_URL'); print(url.path.lstrip('/'))")

DEST_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$DEST_URL').hostname)")
DEST_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.username or ''))")
DEST_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.password or ''))")
DEST_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.path.lstrip('/'))")

echo "Source (RDS):  ${SOURCE_HOST}/${SOURCE_DB}"
echo "Dest (Cloud):  ${DEST_HOST}/${DEST_DB}"
echo ""

# Get tables in publication
echo "Getting tables from publication '$PUBLICATION'..."
PUB_TABLES=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT schemaname || '.' || tablename
  FROM pg_publication_tables
  WHERE pubname = '$PUBLICATION'
  ORDER BY schemaname, tablename;
" 2>/dev/null || echo "")

if [[ -z "$PUB_TABLES" ]]; then
  echo "❌ No tables found in publication"
  exit 1
fi

echo "Found $(echo "$PUB_TABLES" | grep -c .) tables in publication"
echo ""

# Check which tables exist on target
echo "Checking which tables exist on target..."
MISSING_TABLES=()
EXISTING_TABLES=()

while IFS= read -r table_full; do
  if [[ -z "$table_full" ]]; then
    continue
  fi
  
  IFS='.' read -r schema table <<< "$table_full"
  
  # Check if table exists on target
  EXISTS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT COUNT(*)
    FROM information_schema.tables
    WHERE table_schema = '$schema'
      AND table_name = '$table';
  " 2>/dev/null || echo "0")
  
  if [[ "$EXISTS" == "0" ]]; then
    MISSING_TABLES+=("$table_full")
    echo "❌ Missing: $table_full"
  else
    EXISTING_TABLES+=("$table_full")
  fi
done <<< "$PUB_TABLES"

echo ""
echo "========================================="
echo "Summary"
echo "========================================="
echo ""

if [[ ${#MISSING_TABLES[@]} -gt 0 ]]; then
  echo "❌ Missing tables on target (${#MISSING_TABLES[@]}):"
  for table in "${MISSING_TABLES[@]}"; do
    echo "  - $table"
  done
  echo ""
  echo "These tables are in the publication but don't exist on Cloud SQL."
  echo "This will cause replication to fail."
  echo ""
  echo "Options:"
  echo "  1. Create the missing tables on Cloud SQL"
  echo "  2. Remove them from the publication"
  echo "  3. Exclude them from replication"
else
  echo "✓ All tables in publication exist on target"
fi

echo ""
echo "Existing tables: ${#EXISTING_TABLES[@]}"
echo "Missing tables: ${#MISSING_TABLES[@]}"
echo ""

# Also check for tables with PK conflicts
echo "Checking for tables with potential PK conflicts..."
echo ""

for table_full in "${EXISTING_TABLES[@]}"; do
  IFS='.' read -r schema table <<< "$table_full"
  
  # Get primary key column
  PK_COL=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = '$schema.$table'::regclass
      AND i.indisprimary
    LIMIT 1;
  " 2>/dev/null || echo "")
  
  if [[ -n "$PK_COL" ]]; then
    # Check for overlapping primary keys
    OVERLAP=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
      WITH source_pks AS (
        SELECT $PK_COL as pk_val FROM $schema.$table LIMIT 1000
      ),
      target_pks AS (
        SELECT $PK_COL as pk_val FROM $schema.$table LIMIT 1000
      )
      SELECT COUNT(*)
      FROM source_pks s
      WHERE EXISTS (SELECT 1 FROM target_pks t WHERE t.pk_val = s.pk_val);
    " 2>/dev/null || echo "0")
    
    if [[ "$OVERLAP" != "0" ]]; then
      echo "⚠️  $table_full: Potential PK overlap detected (sample: $OVERLAP)"
    fi
  fi
done

echo ""
echo "========================================="

