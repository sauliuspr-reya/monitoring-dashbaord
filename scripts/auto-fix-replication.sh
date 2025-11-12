#!/bin/bash
set -euo pipefail

# Automatically fix replication by removing missing tables from publication

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
PUBLICATION="reya_replication"
SUBSCRIPTION="reya_subscription"

echo "========================================="
echo "Auto-Fix Replication"
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

# Find missing tables
echo "Finding missing tables on target..."
MISSING_TABLES=""

PUB_TABLES=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT schemaname || '.' || tablename
  FROM pg_publication_tables
  WHERE pubname = '$PUBLICATION'
  ORDER BY schemaname, tablename;
" 2>/dev/null || echo "")

while IFS= read -r table_full; do
  if [[ -z "$table_full" ]]; then continue; fi
  IFS='.' read -r schema table <<< "$table_full"
  
  EXISTS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = '$schema' AND table_name = '$table';
  " 2>/dev/null || echo "0")
  
  if [[ "$EXISTS" == "0" ]]; then
    MISSING_TABLES="${MISSING_TABLES}${table_full}"$'\n'
    echo "  ❌ $table_full"
  fi
done <<< "$PUB_TABLES"

# Remove missing tables from publication
if [[ -n "$MISSING_TABLES" ]]; then
  echo ""
  echo "Removing missing tables from publication..."
  echo "$MISSING_TABLES" | while read -r table_full; do
    if [[ -n "$table_full" ]]; then
      IFS='.' read -r schema table_name <<< "$table_full"
      echo "  Removing: $table_full"
      PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -c "
        ALTER PUBLICATION $PUBLICATION DROP TABLE $schema.\"$table_name\";
      " 2>&1 | grep -v "NOTICE" || echo "    ✓ Removed"
    fi
  done
  echo "✓ Publication updated"
else
  echo "✓ No missing tables"
fi

echo ""

# Refresh subscription to pick up publication changes
echo "Refreshing subscription..."
PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
  ALTER SUBSCRIPTION $SUBSCRIPTION REFRESH PUBLICATION;
" 2>&1 | grep -v "NOTICE" || echo "✓ Subscription refreshed"

echo ""

# Enable subscription if disabled
echo "Ensuring subscription is enabled..."
SUB_ENABLED=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT CASE WHEN subenabled THEN 'true' ELSE 'false' END
  FROM pg_subscription WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "false")

if [[ "$SUB_ENABLED" == "false" ]]; then
  echo "Enabling subscription..."
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
    ALTER SUBSCRIPTION $SUBSCRIPTION ENABLE;
  " 2>&1 | grep -v "NOTICE" || echo "✓ Enabled"
  sleep 3
else
  echo "✓ Subscription already enabled"
fi

echo ""

# Check final status
echo "Checking replication status..."
WORKER=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COALESCE(pid::text, 'no_worker')
  FROM pg_stat_subscription
  WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "no_worker")

ERROR_COUNT=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COUNT(*)
  FROM pg_subscription_rel
  WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = '$SUBSCRIPTION')
    AND srsubstate = 'e';
" 2>/dev/null || echo "0")

echo "Worker PID: $WORKER"
echo "Tables in error: $ERROR_COUNT"

if [[ "$ERROR_COUNT" != "0" ]]; then
  echo ""
  echo "Tables with errors:"
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
    SELECT srrelid::regclass as table_name, srsubstate
    FROM pg_subscription_rel
    WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = '$SUBSCRIPTION')
      AND srsubstate = 'e';
  "
fi

echo ""
echo "========================================="
if [[ "$WORKER" != "no_worker" && "$ERROR_COUNT" == "0" ]]; then
  echo "✓ Replication is running"
else
  echo "⚠️  Replication may have issues (check above)"
fi
echo "========================================="

