#!/bin/bash

# Fix the AccountBalanceSeries subscription worker issue

set -e

# Source environment variables
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '^#' | xargs)
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔧 AccountBalanceSeries Subscription Diagnostics & Fix"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "📋 Current Status"
echo "─────────────────────────────────────────────────────"

echo ""
echo "1️⃣  Source Database (AWS) - Replication Slot Status"
echo "─────────────────────────────────────────────────────"
psql "$SOURCE_DATABASE_URL" -c "
SELECT 
  slot_name,
  plugin,
  slot_type,
  active,
  active_pid,
  restart_lsn,
  confirmed_flush_lsn,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as slot_lag
FROM pg_replication_slots 
WHERE slot_name = 'accountbalanceseries_slot';
"

echo ""
echo "2️⃣  Target Database (GCP) - Subscription Status"
echo "─────────────────────────────────────────────────────"
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  subname,
  subenabled,
  subpublications
FROM pg_subscription 
WHERE subname = 'accountbalanceseries_subscription';
"

echo ""
echo "3️⃣  Target Database (GCP) - Worker Process Status"
echo "─────────────────────────────────────────────────────"
WORKER_COUNT=$(psql "$TARGET_DATABASE_URL" -tAc "
SELECT COUNT(*) 
FROM pg_stat_activity 
WHERE application_name LIKE '%accountbalance%';
")

if [ "$WORKER_COUNT" -eq "0" ]; then
  echo "❌ NO WORKER PROCESS RUNNING"
  echo ""
  echo "This means the subscription worker has crashed or failed to start."
else
  echo "✅ Worker process found: $WORKER_COUNT"
  psql "$TARGET_DATABASE_URL" -c "
  SELECT 
    pid,
    application_name,
    state,
    backend_start,
    NOW() - backend_start as uptime
  FROM pg_stat_activity 
  WHERE application_name LIKE '%accountbalance%';
  "
fi

echo ""
echo "4️⃣  Recent Errors from Monitoring Database"
echo "─────────────────────────────────────────────────────"
MONITORING_URL="postgresql://${MONITORING_DB_USER}:${MONITORING_DB_PASSWORD}@${MONITORING_DB_HOST}:${MONITORING_DB_PORT}/${MONITORING_DB_NAME}"
psql "$MONITORING_URL" -c "
SELECT 
  a.created_at,
  a.severity,
  a.message,
  NOW() - a.created_at as time_ago
FROM alerts a 
JOIN subscriptions s ON a.subscription_id = s.id 
WHERE s.name = 'AccountBalanceSeries' 
ORDER BY a.created_at DESC 
LIMIT 5;
"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔧 Proposed Fix"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$WORKER_COUNT" -eq "0" ]; then
  echo "The subscription worker is NOT running. Common causes:"
  echo ""
  echo "1. ❌ Connection failure to source database"
  echo "2. ❌ Permission issues (replication role)"
  echo "3. ❌ Network connectivity problems"
  echo "4. ❌ Subscription was disabled or crashed"
  echo ""
  echo "🔄 Recommended Actions:"
  echo ""
  echo "Option 1: Restart the subscription"
  echo "─────────────────────────────────"
  echo "psql \"\$TARGET_DATABASE_URL\" -c \"ALTER SUBSCRIPTION accountbalanceseries_subscription DISABLE;\""
  echo "psql \"\$TARGET_DATABASE_URL\" -c \"ALTER SUBSCRIPTION accountbalanceseries_subscription ENABLE;\""
  echo ""
  echo "Option 2: Refresh the subscription"
  echo "─────────────────────────────────"
  echo "psql \"\$TARGET_DATABASE_URL\" -c \"ALTER SUBSCRIPTION accountbalanceseries_subscription REFRESH PUBLICATION;\""
  echo ""
  echo "Option 3: Check PostgreSQL logs for detailed errors"
  echo "────────────────────────────────────────────────────"
  echo "kubectl logs -n <namespace> <postgres-pod> --tail=100 | grep -i 'accountbalance'"
  echo ""
  echo "Option 4: Recreate the subscription (NUCLEAR OPTION)"
  echo "─────────────────────────────────────────────────────"
  echo "# Drop and recreate (will lose replication position!)"
  echo "# psql \"\$TARGET_DATABASE_URL\" -c \"DROP SUBSCRIPTION accountbalanceseries_subscription;\""
  echo "# Then recreate via the dashboard"
  echo ""
  
  echo "Would you like to try restarting the subscription? (y/n)"
  read -r response
  if [[ "$response" =~ ^[Yy]$ ]]; then
    echo ""
    echo "🔄 Restarting subscription..."
    psql "$TARGET_DATABASE_URL" -c "ALTER SUBSCRIPTION accountbalanceseries_subscription DISABLE;"
    sleep 2
    psql "$TARGET_DATABASE_URL" -c "ALTER SUBSCRIPTION accountbalanceseries_subscription ENABLE;"
    echo ""
    echo "✅ Subscription restart command issued"
    echo "   Wait 5-10 seconds and check status again..."
    sleep 5
    
    echo ""
    echo "📊 New Worker Status:"
    psql "$TARGET_DATABASE_URL" -c "
    SELECT 
      pid,
      application_name,
      state,
      backend_start
    FROM pg_stat_activity 
    WHERE application_name LIKE '%accountbalance%';
    "
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Diagnostics Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
