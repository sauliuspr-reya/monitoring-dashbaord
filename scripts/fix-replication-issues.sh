#!/bin/bash
set -euo pipefail

# Fix replication issues:
# 1. Remove missing tables from publication
# 2. Identify tables with PK conflicts
# 3. Enable replication

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
PUBLICATION="reya_replication"
SUBSCRIPTION="reya_subscription"

echo "========================================="
echo "Fix Replication Issues"
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

# Step 1: Find missing tables (check publication tables against target)
echo "Step 1: Finding missing tables on target..."
MISSING_ON_TARGET=""

# Get all tables in publication
PUB_TABLES=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT schemaname || '.' || tablename
  FROM pg_publication_tables
  WHERE pubname = '$PUBLICATION'
  ORDER BY schemaname, tablename;
" 2>/dev/null || echo "")

# Check each table exists on target
while IFS= read -r table_full; do
  if [[ -z "$table_full" ]]; then continue; fi
  IFS='.' read -r schema table <<< "$table_full"
  
  EXISTS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = '$schema' AND table_name = '$table';
  " 2>/dev/null || echo "0")
  
  if [[ "$EXISTS" == "0" ]]; then
    MISSING_ON_TARGET="${MISSING_ON_TARGET}${table_full}"$'\n'
    echo "  ❌ $table_full (missing on target)"
  fi
done <<< "$PUB_TABLES"

if [[ -z "$MISSING_ON_TARGET" ]]; then
  echo "✓ No missing tables"
else
  echo ""
  echo "⚠️  Tables missing on target:"
  echo "$MISSING_ON_TARGET" | while read -r table; do
    if [[ -n "$table" ]]; then
      echo "  - $table"
    fi
  done
  echo ""
  read -p "Remove these tables from publication? [y/N]: " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    echo "Removing missing tables from publication..."
    echo "$MISSING_ON_TARGET" | while read -r table; do
      if [[ -n "$table" ]]; then
        IFS='.' read -r schema table_name <<< "$table"
        echo "  Removing: $table"
        PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -c "
          ALTER PUBLICATION $PUBLICATION DROP TABLE $schema.\"$table_name\";
        " 2>&1 || echo "    Failed to remove (may not be in publication)"
      fi
    done
    echo "✓ Updated publication"
  fi
fi

echo ""

# Step 2: Check subscription status and enable
echo "Step 2: Checking subscription status..."
SUB_ENABLED=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT CASE WHEN subenabled THEN 'true' ELSE 'false' END
  FROM pg_subscription WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "false")

if [[ "$SUB_ENABLED" == "false" ]]; then
  echo "Enabling subscription..."
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
    ALTER SUBSCRIPTION $SUBSCRIPTION ENABLE;
  " 2>&1
  echo "✓ Subscription enabled"
  sleep 3
else
  echo "✓ Subscription is enabled"
fi

echo ""

# Step 3: Check for tables in error state
echo "Step 3: Checking for tables with PK conflicts..."
ERROR_TABLES=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT srrelid::regclass::text
  FROM pg_subscription_rel
  WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = '$SUBSCRIPTION')
    AND srsubstate = 'e';
" 2>/dev/null || echo "")

if [[ -n "$ERROR_TABLES" ]]; then
  echo "❌ Tables with conflicts:"
  echo "$ERROR_TABLES" | while read -r table; do
    if [[ -n "$table" ]]; then
      echo "  - $table"
    fi
  done
  echo ""
  echo "These tables are causing replication to stop."
  echo ""
  echo "Options:"
  echo "  1. Refresh publication: ALTER PUBLICATION $PUBLICATION REFRESH PUBLICATION;"
  echo "  2. Remove problematic tables from publication"
  echo "  3. Fix the duplicate keys manually"
else
  echo "✓ No tables currently in error state"
fi

echo ""

# Step 4: Final status
echo "Step 4: Final replication status..."
WORKER=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COALESCE(pid::text, 'no_worker')
  FROM pg_stat_subscription
  WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "no_worker")

if [[ "$WORKER" != "no_worker" ]]; then
  echo "✓ Replication worker running (PID: $WORKER)"
else
  echo "⚠️  Replication worker not running"
  echo ""
  echo "Check for errors:"
  echo "  psql -h $DEST_HOST -U $DEST_USER -d $DEST_DB -c \"SELECT * FROM pg_subscription_rel WHERE srsubstate = 'e';\""
fi

echo ""
echo "========================================="
echo "✓ Done"
echo "========================================="

