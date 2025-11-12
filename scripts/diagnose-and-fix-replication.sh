#!/bin/bash
set -euo pipefail

# Diagnose replication issues and enable replication
# Checks for PK conflicts and enables subscription

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
SUBSCRIPTION="reya_subscription"
PUBLICATION="reya_replication"

echo "========================================="
echo "Diagnose and Fix Replication"
echo "========================================="
echo ""

# Get credentials
if ! kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "❌ Error: Secret not found"
  exit 1
fi

SOURCE_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.source-database-url}' | base64 -d)
DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)

# Parse connections
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

# Step 1: Check if subscription exists
echo "Step 1: Checking subscription..."
SUB_EXISTS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COUNT(*) FROM pg_subscription WHERE subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "0")

if [[ "$SUB_EXISTS" == "0" ]]; then
  echo "❌ Subscription '$SUBSCRIPTION' does not exist"
  echo ""
  echo "Checking if publication exists on source..."
  PUB_EXISTS=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
    SELECT COUNT(*) FROM pg_publication WHERE pubname = '$PUBLICATION';
  " 2>/dev/null || echo "0")
  
  if [[ "$PUB_EXISTS" == "0" ]]; then
    echo "❌ Publication '$PUBLICATION' also doesn't exist"
    echo ""
    echo "You need to create both publication and subscription."
    echo "Run: cd ../migration && ./setup-replication.sh"
    exit 1
  fi
  
  echo "✓ Publication exists. Creating subscription..."
  
  # Check if slot exists
  SLOT_EXISTS=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
    SELECT COUNT(*) FROM pg_replication_slots WHERE slot_name = '$SUBSCRIPTION';
  " 2>/dev/null || echo "0")
  
  if [[ "$SLOT_EXISTS" == "1" ]]; then
    echo "✓ Replication slot exists, using it"
    CREATE_SLOT="false"
  else
    echo "⚠️  Replication slot doesn't exist, will create it"
    CREATE_SLOT="true"
  fi
  
  # Create subscription
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" <<EOF
CREATE SUBSCRIPTION $SUBSCRIPTION
  CONNECTION 'host=$SOURCE_HOST port=5432 dbname=$SOURCE_DB user=$SOURCE_USER password=$SOURCE_PASS'
  PUBLICATION $PUBLICATION
  WITH (
    create_slot = $CREATE_SLOT,
    slot_name = '$SUBSCRIPTION',
    copy_data = false,
    enabled = true,
    streaming = parallel
  );
EOF
  
  if [[ $? -eq 0 ]]; then
    echo "✓ Subscription created"
    sleep 3
  else
    echo "❌ Failed to create subscription"
    exit 1
  fi
else
  echo "✓ Subscription exists"
  
  # Check if enabled
  SUB_ENABLED=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT CASE WHEN subenabled THEN 'true' ELSE 'false' END
    FROM pg_subscription WHERE subname = '$SUBSCRIPTION';
  " 2>/dev/null || echo "false")
  
  if [[ "$SUB_ENABLED" == "false" ]]; then
    echo "⚠️  Subscription is disabled. Enabling..."
    PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -c "
      ALTER SUBSCRIPTION $SUBSCRIPTION ENABLE;
    " 2>&1
    echo "✓ Subscription enabled"
    sleep 3
  else
    echo "✓ Subscription is enabled"
  fi
fi

echo ""

# Step 2: Check for tables in error state
echo "Step 2: Checking for tables with PK conflicts..."
ERROR_TABLES=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT srrelid::regclass::text || '|' || srsubstate
  FROM pg_subscription_rel
  WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = '$SUBSCRIPTION')
    AND srsubstate = 'e';
" 2>/dev/null || echo "")

if [[ -n "$ERROR_TABLES" ]]; then
  echo "❌ Tables with conflicts:"
  echo "$ERROR_TABLES" | while IFS='|' read -r table state; do
    if [[ -n "$table" ]]; then
      echo "  - $table (state: $state)"
      
      # Try to get more details about the error
      echo "    Checking for duplicate keys..."
      
      # Get primary key column
      PK_COL=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = '$table'::regclass
          AND i.indisprimary
        LIMIT 1;
      " 2>/dev/null || echo "")
      
      if [[ -n "$PK_COL" ]]; then
        # Count duplicates between source and target
        DUPS=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
          WITH source_pks AS (
            SELECT $PK_COL as pk_val FROM $table
          ),
          target_pks AS (
            SELECT $PK_COL as pk_val FROM $table
          )
          SELECT COUNT(*)
          FROM source_pks s
          WHERE EXISTS (SELECT 1 FROM target_pks t WHERE t.pk_val = s.pk_val);
        " 2>/dev/null || echo "0")
        
        echo "    Primary key column: $PK_COL"
        echo "    Potential duplicate count: $DUPS"
      fi
    fi
  done
  echo ""
  echo "⚠️  These tables have conflicts. You may need to:"
  echo "  1. Fix the duplicate keys"
  echo "  2. Or exclude these tables from replication"
  echo "  3. Or refresh the subscription: ALTER SUBSCRIPTION $SUBSCRIPTION REFRESH PUBLICATION;"
else
  echo "✓ No tables in error state"
fi

echo ""

# Step 3: Check worker status
echo "Step 3: Checking replication worker status..."
WORKER_STATUS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT 
    CASE WHEN ss.pid IS NOT NULL THEN 'running' ELSE 'stopped' END || '|' ||
    COALESCE(ss.pid::text, 'no_worker') || '|' ||
    COALESCE(EXTRACT(EPOCH FROM (now() - ss.latest_end_time))::int::text, 'never')
  FROM pg_subscription s
  LEFT JOIN pg_stat_subscription ss ON s.subname = ss.subname
  WHERE s.subname = '$SUBSCRIPTION';
" 2>/dev/null || echo "stopped|no_worker|never")

IFS='|' read -r WORKER_STATE WORKER_PID LAST_APPLY <<< "$WORKER_STATUS"

echo "Worker state: $WORKER_STATE"
echo "Worker PID: $WORKER_PID"
if [[ "$LAST_APPLY" != "never" ]]; then
  echo "Last apply: ${LAST_APPLY}s ago"
else
  echo "Last apply: never"
fi

if [[ "$WORKER_STATE" == "stopped" ]]; then
  echo ""
  echo "⚠️  Worker is not running. This could be due to:"
  echo "  1. Subscription disabled (should be enabled now)"
  echo "  2. Tables in error state (see above)"
  echo "  3. Connection issues"
  echo ""
  echo "Check PostgreSQL logs for details"
fi

echo ""

# Step 4: Check replication lag
echo "Step 4: Checking replication lag..."
LAG=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn))
  FROM pg_stat_replication
  WHERE application_name = '$SUBSCRIPTION';
" 2>/dev/null || echo "N/A")

echo "Replication lag: $LAG"

echo ""
echo "========================================="
echo "Summary"
echo "========================================="
echo ""

if [[ -n "$ERROR_TABLES" ]]; then
  echo "❌ ISSUES FOUND:"
  echo "  - Tables with conflicts (see above)"
  echo "  - Replication may be stopped due to these conflicts"
  echo ""
  echo "To fix:"
  echo "  1. Identify the specific duplicate keys"
  echo "  2. Remove duplicates or fix data"
  echo "  3. Refresh subscription: ALTER SUBSCRIPTION $SUBSCRIPTION REFRESH PUBLICATION;"
else
  echo "✓ No conflicts detected"
  if [[ "$WORKER_STATE" == "running" ]]; then
    echo "✓ Replication worker is running"
  else
    echo "⚠️  Replication worker is not running (check logs)"
  fi
fi

echo ""
echo "Monitor with: ./monitor-replication.sh"
echo ""

