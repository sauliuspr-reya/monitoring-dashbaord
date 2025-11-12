#!/bin/bash
set -euo pipefail

# Check why replication worker is stopped

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
SUBSCRIPTION="reya_subscription"

echo "========================================="
echo "Check Replication Worker Status"
echo "========================================="
echo ""

# Get credentials
DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)

DEST_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$DEST_URL').hostname)")
DEST_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.port or 5432)")
DEST_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.username or ''))")
DEST_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.password or ''))")
DEST_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.path.lstrip('/'))")

echo "Checking subscription worker status..."
echo ""

# Check subscription status
echo "1. Subscription Status:"
PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
  SELECT 
    subname,
    subenabled,
    subslotname,
    subpublications
  FROM pg_subscription
  WHERE subname = '$SUBSCRIPTION';
"
echo ""

# Check worker process
echo "2. Worker Process:"
WORKER=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COALESCE(pid::text, 'no_worker')
  FROM pg_stat_subscription
  WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "no_worker")

if [[ "$WORKER" == "no_worker" ]]; then
  echo "  ❌ No worker process found"
  echo ""
  echo "3. Checking for aborted transactions:"
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
    SELECT 
      pid,
      application_name,
      state,
      LEFT(query, 150) as query_preview,
      state_change
    FROM pg_stat_activity
    WHERE state = 'idle in transaction (aborted)'
       OR (application_name LIKE '%$SUBSCRIPTION%' AND state != 'idle')
    ORDER BY state_change DESC
    LIMIT 10;
  "
else
  echo "  ✓ Worker PID: $WORKER"
  echo ""
  echo "3. Worker Details:"
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
    SELECT 
      subname,
      pid,
      received_lsn,
      latest_end_lsn,
      latest_end_time,
      EXTRACT(EPOCH FROM (now() - latest_end_time))::int as seconds_since_last_apply
    FROM pg_stat_subscription
    WHERE subname = '$SUBSCRIPTION';
  "
fi

echo ""

# Check tables in error state
echo "4. Tables in Error State:"
ERROR_TABLES=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COUNT(*)
  FROM pg_subscription_rel
  WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = '$SUBSCRIPTION')
    AND srsubstate = 'e';
" 2>/dev/null || echo "0")

if [[ "$ERROR_TABLES" != "0" ]]; then
  echo "  ❌ Found $ERROR_TABLES table(s) in error state:"
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
    SELECT 
      srrelid::regclass as table_name,
      srsubstate,
      srsublsn
    FROM pg_subscription_rel
    WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = '$SUBSCRIPTION')
      AND srsubstate = 'e'
    ORDER BY srrelid;
  "
else
  echo "  ✓ No tables in error state"
fi

echo ""

# Check PostgreSQL logs (if accessible)
echo "5. Recent PostgreSQL Log Messages:"
echo "   (Check Cloud SQL logs in GCP Console for detailed error messages)"
echo ""

# Try to restart worker by refreshing subscription
if [[ "$WORKER" == "no_worker" ]]; then
  echo "========================================="
  echo "Attempting to Restart Worker"
  echo "========================================="
  echo ""
  echo "Refreshing subscription..."
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
    ALTER SUBSCRIPTION $SUBSCRIPTION REFRESH PUBLICATION;
  " 2>&1 | grep -v "NOTICE" || echo "✓ Refreshed"
  
  sleep 2
  
  NEW_WORKER=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT COALESCE(pid::text, 'no_worker')
    FROM pg_stat_subscription
    WHERE subname = '$SUBSCRIPTION';
  " 2>/dev/null || echo "no_worker")
  
  if [[ "$NEW_WORKER" != "no_worker" ]]; then
    echo "✓ Worker started (PID: $NEW_WORKER)"
  else
    echo "❌ Worker still not running. Check PostgreSQL logs for errors."
  fi
fi

echo ""
echo "========================================="
echo "✓ Done"
echo "========================================="

