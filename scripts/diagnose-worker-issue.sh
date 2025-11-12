#!/bin/bash
set -euo pipefail

# Diagnose why worker isn't starting

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
SUBSCRIPTION="reya_subscription"

echo "========================================="
echo "Diagnose Worker Issue"
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

echo "1. Checking subscription connection string..."
SUB_CONN=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT subconninfo
  FROM pg_subscription
  WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "")

if [[ -n "$SUB_CONN" ]]; then
  echo "  Connection string configured"
  # Extract host from connection string
  SUB_HOST=$(echo "$SUB_CONN" | grep -oP "host=\K[^\s]+" || echo "")
  if [[ -n "$SUB_HOST" ]]; then
    echo "  Target host: $SUB_HOST"
    echo "  Expected host: $SOURCE_HOST"
    if [[ "$SUB_HOST" != "$SOURCE_HOST" ]]; then
      echo "  ⚠️  Host mismatch!"
    fi
  fi
else
  echo "  ❌ No connection string found"
fi

echo ""

echo "2. Testing connection from Cloud SQL to RDS..."
if PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -c "SELECT 1;" &>/dev/null; then
  echo "  ✓ Connection successful"
else
  echo "  ❌ Connection failed - this is likely why worker isn't starting"
  echo "     Check network connectivity and firewall rules"
fi

echo ""

echo "3. Checking replication slot on source..."
SLOT_STATUS=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT 
    slot_name || '|' ||
    CASE WHEN active THEN 'active' ELSE 'inactive' END || '|' ||
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
  FROM pg_replication_slots
  WHERE slot_name = '$SUBSCRIPTION';
" 2>/dev/null || echo "")

if [[ -n "$SLOT_STATUS" ]]; then
  IFS='|' read -r SLOT_NAME SLOT_ACTIVE SLOT_LAG <<< "$SLOT_STATUS"
  echo "  Slot: $SLOT_NAME"
  echo "  Status: $SLOT_ACTIVE"
  echo "  WAL Lag: $SLOT_LAG"
  if [[ "$SLOT_ACTIVE" == "inactive" ]]; then
    echo "  ⚠️  Slot is inactive - worker should activate it when running"
  fi
else
  echo "  ❌ Replication slot not found on source"
fi

echo ""

echo "4. Checking subscription state details..."
PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
  SELECT 
    subname,
    subenabled,
    subslotname,
    subpublications,
    subconninfo IS NOT NULL as has_conninfo
  FROM pg_subscription
  WHERE subname = '$SUBSCRIPTION';
"

echo ""

echo "5. Attempting to enable and refresh subscription..."
echo "   Disabling first..."
PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
  ALTER SUBSCRIPTION $SUBSCRIPTION DISABLE;
" 2>&1 | grep -v "NOTICE" || echo "  ✓ Disabled"

sleep 1

echo "   Enabling..."
PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
  ALTER SUBSCRIPTION $SUBSCRIPTION ENABLE;
" 2>&1 | grep -v "NOTICE" || echo "  ✓ Enabled"

sleep 3

echo "   Refreshing publication..."
PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
  ALTER SUBSCRIPTION $SUBSCRIPTION REFRESH PUBLICATION;
" 2>&1 | grep -v "NOTICE" || echo "  ✓ Refreshed"

sleep 3

echo ""
echo "6. Checking if worker started..."
NEW_WORKER=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COALESCE(pid::text, 'no_worker')
  FROM pg_stat_subscription
  WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "no_worker")

if [[ "$NEW_WORKER" != "no_worker" ]]; then
  echo "  ✓ Worker started (PID: $NEW_WORKER)"
else
  echo "  ❌ Worker still not running"
  echo ""
  echo "  Check PostgreSQL error logs on Cloud SQL for details."
  echo "  Common issues:"
  echo "    - Connection timeout to source database"
  echo "    - Authentication failure"
  echo "    - Network connectivity issues"
  echo "    - Replication slot already in use"
fi

echo ""
echo "========================================="
echo "✓ Done"
echo "========================================="

