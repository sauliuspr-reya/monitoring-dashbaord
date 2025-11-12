#!/bin/bash
set -euo pipefail

# Check replication status and enable if disabled
# Uses Kubernetes secret for credentials

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
SUBSCRIPTION="reya_subscription"

echo "========================================="
echo "Check and Enable Replication"
echo "========================================="
echo ""

# Get credentials from K8s secret
if ! kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "❌ Error: Secret $SECRET_NAME not found in namespace $NAMESPACE"
  exit 1
fi

echo "✓ Secret found"
echo ""

# Extract connection strings
SOURCE_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.source-database-url}' | base64 -d)
DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)

if [[ -z "$SOURCE_URL" ]] || [[ -z "$DEST_URL" ]]; then
  echo "❌ Error: Could not extract connection strings"
  exit 1
fi

# Parse connection details
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

# Check subscription status
echo "Checking subscription status..."
SUB_STATUS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT 
    subname || '|' ||
    CASE WHEN subenabled THEN 'enabled' ELSE 'disabled' END || '|' ||
    COALESCE((SELECT pid::text FROM pg_stat_subscription WHERE subname = s.subname), 'no_worker')
  FROM pg_subscription s
  WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "")

if [[ -z "$SUB_STATUS" ]]; then
  echo "❌ Subscription '$SUBSCRIPTION' not found!"
  echo ""
  echo "You may need to create it first. Run:"
  echo "  ./create-subscription-final.sh"
  exit 1
fi

IFS='|' read -r SUB_NAME SUB_ENABLED WORKER_PID <<< "$SUB_STATUS"

echo "Subscription: $SUB_NAME"
echo "Status: $SUB_ENABLED"
echo "Worker PID: $WORKER_PID"
echo ""

# Check replication slot on source
echo "Checking replication slot on source..."
SLOT_STATUS=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT 
    slot_name || '|' ||
    CASE WHEN active THEN 'active' ELSE 'inactive' END || '|' ||
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
  FROM pg_replication_slots
  WHERE slot_name = '$SUBSCRIPTION';
" 2>/dev/null || echo "")

if [[ -n "$SLOT_STATUS" ]]; then
  IFS='|' read -r SLOT_NAME SLOT_ACTIVE SLOT_LAG <<< "$SLOT_STATUS"
  echo "Slot: $SLOT_NAME"
  echo "Status: $SLOT_ACTIVE"
  echo "WAL Lag: $SLOT_LAG"
  echo ""
else
  echo "⚠️  Replication slot not found on source"
  echo ""
fi

# Check for errors in pg_subscription_rel
echo "Checking for tables in error state..."
ERROR_TABLES=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT srrelid::regclass::text
  FROM pg_subscription_rel
  WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = '$SUBSCRIPTION')
    AND srsubstate = 'e';
" 2>/dev/null || echo "")

if [[ -n "$ERROR_TABLES" ]]; then
  echo "❌ Tables in error state:"
  echo "$ERROR_TABLES" | while read -r table; do
    if [[ -n "$table" ]]; then
      echo "  - $table"
    fi
  done
  echo ""
else
  echo "✓ No tables in error state"
  echo ""
fi

# Enable subscription if disabled
if [[ "$SUB_ENABLED" == "disabled" ]]; then
  echo "Subscription is disabled. Enabling..."
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
    ALTER SUBSCRIPTION $SUBSCRIPTION ENABLE;
  " 2>&1
  
  if [[ $? -eq 0 ]]; then
    echo "✓ Subscription enabled"
    echo ""
    echo "Waiting 5 seconds for worker to start..."
    sleep 5
    
    # Check worker status
    NEW_WORKER=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
      SELECT COALESCE(pid::text, 'no_worker')
      FROM pg_stat_subscription
      WHERE subname = '$SUBSCRIPTION';
    " 2>/dev/null || echo "no_worker")
    
    if [[ "$NEW_WORKER" != "no_worker" ]]; then
      echo "✓ Worker started (PID: $NEW_WORKER)"
    else
      echo "⚠️  Worker not started yet. Check logs for errors."
    fi
  else
    echo "❌ Failed to enable subscription"
    exit 1
  fi
else
  echo "✓ Subscription is already enabled"
fi

echo ""
echo "========================================="
echo "Final Status"
echo "========================================="
echo ""

# Show final status
PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
  SELECT 
    s.subname as \"Subscription\",
    CASE WHEN s.subenabled THEN 'Enabled' ELSE 'Disabled' END as \"Status\",
    CASE WHEN ss.pid IS NOT NULL THEN 'Running (PID: ' || ss.pid || ')' ELSE 'Stopped' END as \"Worker\",
    CASE 
      WHEN ss.latest_end_time IS NOT NULL 
      THEN EXTRACT(EPOCH FROM (now() - ss.latest_end_time))::int || 's ago'
      ELSE 'Never'
    END as \"Last Apply\"
  FROM pg_subscription s
  LEFT JOIN pg_stat_subscription ss ON s.subname = ss.subname
  WHERE s.subname = '$SUBSCRIPTION';
"

echo ""
echo "Replication slot status:"
PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -c "
  SELECT 
    slot_name,
    active,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as \"WAL Lag\"
  FROM pg_replication_slots
  WHERE slot_name = '$SUBSCRIPTION';
"

echo ""
echo "========================================="
echo "✓ Done"
echo "========================================="

