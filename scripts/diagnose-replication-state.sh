#!/bin/bash

set -euo pipefail

# Comprehensive Replication Diagnostics
# Checks the state of both PostgreSQL replication AND the monitoring dashboard

echo "=========================================="
echo "Replication Diagnostics"
echo "=========================================="
echo ""

# Get credentials from K8s secret or env vars
NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"

# Try to get from K8s secret first
if kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "✓ Found K8s secret"
  SOURCE_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.source-database-url}' | base64 -d)
  DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)
  MONITORING_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.monitoring-database-url}' | base64 -d 2>/dev/null || echo "")
else
  echo "⚠️  K8s secret not found, trying environment variables..."
  SOURCE_URL="${SOURCE_DATABASE_URL:-}"
  DEST_URL="${TARGET_DATABASE_URL:-}"
  MONITORING_URL="${MONITORING_DATABASE_URL:-}"
fi

if [[ -z "$SOURCE_URL" ]] || [[ -z "$DEST_URL" ]]; then
  echo "❌ Error: Database URLs not found"
  echo ""
  echo "Please set one of:"
  echo "  1. K8s secret: ${NAMESPACE}/${SECRET_NAME}"
  echo "  2. Environment variables: SOURCE_DATABASE_URL, TARGET_DATABASE_URL"
  exit 1
fi

# Parse connection details
parse_url() {
  local url=$1
  python3 -c "
from urllib.parse import urlparse, unquote
url = urlparse('$url')
print(f'{url.hostname or \"localhost\"}|{url.port or 5432}|{unquote(url.username or \"postgres\")}|{unquote(url.password or \"\")}|{url.path.lstrip(\"/\") or \"reya\"}')
"
}

IFS='|' read -r SOURCE_HOST SOURCE_PORT SOURCE_USER SOURCE_PASS SOURCE_DB <<< "$(parse_url "$SOURCE_URL")"
IFS='|' read -r DEST_HOST DEST_PORT DEST_USER DEST_PASS DEST_DB <<< "$(parse_url "$DEST_URL")"

echo ""
echo "Connection Info:"
echo "  Source (RDS):  ${SOURCE_HOST}:${SOURCE_PORT}/${SOURCE_DB}"
echo "  Dest (GCP):    ${DEST_HOST}:${DEST_PORT}/${DEST_DB}"

if [[ -n "$MONITORING_URL" ]]; then
  IFS='|' read -r MON_HOST MON_PORT MON_USER MON_PASS MON_DB <<< "$(parse_url "$MONITORING_URL")"
  echo "  Monitoring:    ${MON_HOST}:${MON_PORT}/${MON_DB}"
else
  echo "  Monitoring:    Not configured"
fi

echo ""
echo "=========================================="
echo "1. PostgreSQL Logical Replication Status"
echo "=========================================="
echo ""

# Check if any subscriptions exist on GCP
echo "Checking for PostgreSQL subscriptions on GCP..."
SUBSCRIPTIONS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COUNT(*) FROM pg_subscription;
" 2>/dev/null || echo "0")

if [[ "$SUBSCRIPTIONS" == "0" ]]; then
  echo "❌ No PostgreSQL subscriptions found on GCP!"
  echo ""
  echo "This means logical replication has not been set up yet."
  echo "You need to:"
  echo "  1. Create a publication on RDS (source)"
  echo "  2. Create a subscription on GCP (destination)"
  echo ""
  echo "Available scripts:"
  echo "  - Look for scripts with 'create-subscription' in the name"
  echo ""
else
  echo "✓ Found $SUBSCRIPTIONS subscription(s)"
  echo ""
  
  # Show detailed subscription info
  echo "Subscription details:"
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
    SELECT 
      s.subname as \"Name\",
      s.subpublication as \"Publication\",
      CASE WHEN s.subenabled THEN 'Enabled' ELSE 'Disabled' END as \"Status\",
      CASE WHEN ss.pid IS NOT NULL THEN 'Running (PID: ' || ss.pid || ')' ELSE 'Stopped' END as \"Worker\",
      CASE 
        WHEN ss.latest_end_time IS NOT NULL 
        THEN EXTRACT(EPOCH FROM (now() - ss.latest_end_time))::int || 's ago'
        ELSE 'Never'
      END as \"Last Apply\"
    FROM pg_subscription s
    LEFT JOIN pg_stat_subscription ss ON s.subname = ss.subname;
  " 2>/dev/null
  
  echo ""
  
  # Check for tables in error state
  echo "Checking for tables with replication errors..."
  ERROR_COUNT=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT COUNT(*)
    FROM pg_subscription_rel
    WHERE srsubstate = 'e';
  " 2>/dev/null || echo "0")
  
  if [[ "$ERROR_COUNT" != "0" ]]; then
    echo "❌ Found $ERROR_COUNT table(s) in error state:"
    PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
      SELECT 
        sr.srrelid::regclass as \"Table\",
        s.subname as \"Subscription\"
      FROM pg_subscription_rel sr
      JOIN pg_subscription s ON s.oid = sr.srsubid
      WHERE sr.srsubstate = 'e';
    " 2>/dev/null
  else
    echo "✓ No tables in error state"
  fi
  
  echo ""
  
  # Check replication slot on source
  echo "Checking replication slots on source (RDS)..."
  SLOTS=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -c "
    SELECT 
      slot_name as \"Slot\",
      CASE WHEN active THEN 'Active' ELSE 'Inactive' END as \"Status\",
      pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as \"WAL Lag\"
    FROM pg_replication_slots
    WHERE slot_type = 'logical';
  " 2>/dev/null || echo "")
  
  if [[ -n "$SLOTS" ]]; then
    echo "$SLOTS"
  else
    echo "⚠️  No logical replication slots found on source"
  fi
fi

echo ""
echo "=========================================="
echo "2. Monitoring Dashboard Database"
echo "=========================================="
echo ""

if [[ -z "$MONITORING_URL" ]]; then
  echo "⚠️  Monitoring database URL not configured"
  echo ""
  echo "The dashboard won't be able to track subscriptions without this."
  echo "Set MONITORING_DATABASE_URL or add to K8s secret as 'monitoring-database-url'"
  echo ""
  SKIP_MONITORING=true
else
  SKIP_MONITORING=false
  
  # Check if monitoring database is accessible
  echo "Connecting to monitoring database..."
  MON_TEST=$(PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" -t -A -c "SELECT 1;" 2>/dev/null || echo "0")
  
  if [[ "$MON_TEST" == "1" ]]; then
    echo "✓ Connected to monitoring database"
    echo ""
    
    # Check if subscriptions table exists
    SUBS_TABLE=$(PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" -t -A -c "
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'subscriptions'
      );
    " 2>/dev/null || echo "f")
    
    if [[ "$SUBS_TABLE" == "t" ]]; then
      echo "✓ Subscriptions table exists"
      
      # Check how many subscriptions are tracked
      TRACKED_SUBS=$(PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" -t -A -c "
        SELECT COUNT(*) FROM subscriptions;
      " 2>/dev/null || echo "0")
      
      if [[ "$TRACKED_SUBS" == "0" ]]; then
        echo "❌ No subscriptions tracked in monitoring dashboard!"
        echo ""
        echo "The dashboard needs at least one subscription to work."
        echo "You need to add your subscription to the monitoring database."
        echo ""
        echo "This is likely why you're not seeing any tables."
      else
        echo "✓ Found $TRACKED_SUBS subscription(s) tracked in dashboard"
        echo ""
        echo "Tracked subscriptions:"
        PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" -c "
          SELECT 
            name as \"Name\",
            publication_name as \"Publication\",
            subscription_name as \"PG Subscription\",
            CASE WHEN enabled THEN 'Enabled' ELSE 'Disabled' END as \"Enabled\"
          FROM subscriptions
          ORDER BY created_at DESC;
        " 2>/dev/null
      fi
    else
      echo "❌ Subscriptions table does not exist!"
      echo ""
      echo "The monitoring database schema needs to be created."
      echo "Run the schema setup:"
      echo "  psql -h ${MON_HOST} -U ${MON_USER} -d ${MON_DB} < lib/db/schema.sql"
    fi
  else
    echo "❌ Cannot connect to monitoring database"
    echo ""
    echo "Check your monitoring database credentials."
  fi
fi

echo ""
echo "=========================================="
echo "3. Tables Status"
echo "=========================================="
echo ""

# Check how many tables exist on source and destination
echo "Checking table counts..."

SOURCE_TABLE_COUNT=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';
" 2>/dev/null || echo "0")

DEST_TABLE_COUNT=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';
" 2>/dev/null || echo "0")

echo "  Source (RDS): $SOURCE_TABLE_COUNT tables"
echo "  Dest (GCP):   $DEST_TABLE_COUNT tables"

if [[ "$DEST_TABLE_COUNT" == "0" ]]; then
  echo ""
  echo "⚠️  No tables on destination!"
  echo "You may need to:"
  echo "  1. Create the schema on GCP"
  echo "  2. Initial data sync before starting replication"
fi

if [[ "$SUBSCRIPTIONS" != "0" ]]; then
  echo ""
  echo "Checking which tables are in subscriptions..."
  PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -c "
    SELECT 
      s.subname as \"Subscription\",
      COUNT(*) as \"Tables\"
    FROM pg_subscription s
    JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
    GROUP BY s.subname;
  " 2>/dev/null || echo "No subscription tables found"
fi

echo ""
echo "=========================================="
echo "Summary & Next Steps"
echo "=========================================="
echo ""

# Determine what needs to be done
NEEDS_PG_SUBSCRIPTION=false
NEEDS_MONITORING_SUBSCRIPTION=false
NEEDS_ENABLE=false

if [[ "$SUBSCRIPTIONS" == "0" ]]; then
  NEEDS_PG_SUBSCRIPTION=true
  echo "❌ PostgreSQL logical replication is NOT set up"
  echo "   → Create publication on source and subscription on destination"
  echo ""
fi

if [[ "$SKIP_MONITORING" == "false" ]] && [[ "$TRACKED_SUBS" == "0" ]]; then
  NEEDS_MONITORING_SUBSCRIPTION=true
  echo "❌ Monitoring dashboard has NO tracked subscriptions"
  echo "   → Add subscription to monitoring database"
  echo ""
fi

# Check if subscription is disabled
if [[ "$SUBSCRIPTIONS" != "0" ]]; then
  DISABLED_SUBS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
    SELECT COUNT(*) FROM pg_subscription WHERE NOT subenabled;
  " 2>/dev/null || echo "0")
  
  if [[ "$DISABLED_SUBS" != "0" ]]; then
    NEEDS_ENABLE=true
    echo "⚠️  Some subscriptions are DISABLED"
    echo "   → Enable them with ALTER SUBSCRIPTION ... ENABLE"
    echo ""
  fi
fi

if [[ "$NEEDS_PG_SUBSCRIPTION" == "false" ]] && [[ "$NEEDS_MONITORING_SUBSCRIPTION" == "false" ]] && [[ "$NEEDS_ENABLE" == "false" ]]; then
  echo "✓ Everything looks good!"
  echo ""
  echo "If the dashboard still shows no tables:"
  echo "  1. Refresh the browser"
  echo "  2. Check browser console for errors (F12)"
  echo "  3. Check that .env.local has MONITORING_DB_* variables"
else
  echo "To fix the issues:"
  echo ""
  
  if [[ "$NEEDS_PG_SUBSCRIPTION" == "true" ]]; then
    echo "1. Create PostgreSQL logical replication:"
    echo "   Look for scripts like:"
    echo "   - scripts/create-subscription-*.sh"
    echo "   - Or follow CREATE-SUBSCRIPTION-GUIDE.md"
    echo ""
  fi
  
  if [[ "$NEEDS_MONITORING_SUBSCRIPTION" == "true" ]]; then
    echo "2. Add subscription to monitoring dashboard:"
    echo "   Use the dashboard UI at http://localhost:3002/subscriptions/new"
    echo "   Or use IMPORT-EXISTING-SUBSCRIPTIONS.sql"
    echo ""
  fi
  
  if [[ "$NEEDS_ENABLE" == "true" ]]; then
    echo "3. Enable disabled subscriptions:"
    echo "   Run: scripts/check-and-enable-replication.sh"
    echo ""
  fi
fi

echo "=========================================="

