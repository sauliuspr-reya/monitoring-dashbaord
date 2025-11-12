#!/bin/bash

# Query replication logs directly from PostgreSQL
# Usage: ./scripts/query-replication-logs.sh [time_range] [subscription_name]

set -e

TIME_RANGE=${1:-"1 hour"}
SUBSCRIPTION_NAME=${2:-""}

echo "📝 Querying Replication Logs"
echo "=========================================="
echo "Time Range: Last $TIME_RANGE"
if [ -n "$SUBSCRIPTION_NAME" ]; then
  echo "Subscription: $SUBSCRIPTION_NAME"
else
  echo "Subscription: All"
fi
echo ""

# Load environment variables
if [ -f .env.local ]; then
  source .env.local
else
  echo "❌ Error: .env.local not found"
  exit 1
fi

# Parse target database connection
TARGET_DB_URL="${TARGET_DATABASE_URL}"
TARGET_DB_HOST=$(echo "$TARGET_DB_URL" | sed 's/.*@\([^:]*\):.*/\1/')
TARGET_DB_PORT=$(echo "$TARGET_DB_URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
TARGET_DB_NAME=$(echo "$TARGET_DB_URL" | sed 's/.*\/\([^?]*\).*/\1/')
TARGET_DB_USER=$(echo "$TARGET_DB_URL" | sed 's/.*\/\/\([^:]*\):.*/\1/')
TARGET_DB_PASSWORD=$(echo "$TARGET_DB_URL" | sed 's/.*\/\/[^:]*:\([^@]*\)@.*/\1/' | sed 's/%24/$/g' | sed 's/%3D/=/g')

# Parse source database connection
SOURCE_DB_URL="${SOURCE_DATABASE_URL}"
SOURCE_DB_HOST=$(echo "$SOURCE_DB_URL" | sed 's/.*@\([^:]*\):.*/\1/')
SOURCE_DB_PORT=$(echo "$SOURCE_DB_URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
SOURCE_DB_NAME=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\([^?]*\).*/\1/')
SOURCE_DB_USER=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\/\([^:]*\):.*/\1/')
SOURCE_DB_PASSWORD=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\/[^:]*:\([^@]*\)@.*/\1/' | sed 's/%24/$/g' | sed 's/%3D/=/g')

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1️⃣  SUBSCRIPTION WORKER STATUS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SUBSCRIPTION_FILTER=""
if [ -n "$SUBSCRIPTION_NAME" ]; then
  SUBSCRIPTION_FILTER="WHERE subname = '$SUBSCRIPTION_NAME'"
fi

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  subname AS "Subscription",
  CASE 
    WHEN pid IS NULL THEN '❌ NOT RUNNING'
    ELSE '✅ RUNNING (PID: ' || pid || ')'
  END AS "Worker Status",
  CASE 
    WHEN latest_end_time > NOW() - INTERVAL '$TIME_RANGE' THEN '✅ Active'
    WHEN latest_end_time IS NULL THEN '⚠️  Never synced'
    ELSE '⚠️  Stale (' || EXTRACT(EPOCH FROM (NOW() - latest_end_time))::int / 60 || 'm ago)'
  END AS "Last Activity",
  received_lsn AS "Received LSN",
  latest_end_lsn AS "Latest LSN",
  TO_CHAR(latest_end_time, 'YYYY-MM-DD HH24:MI:SS') AS "Last Sync"
FROM pg_stat_subscription
$SUBSCRIPTION_FILTER
ORDER BY subname;
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2️⃣  TABLE REPLICATION STATUS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
WITH table_states AS (
  SELECT 
    s.subname,
    sr.srsubstate::text as state,
    COUNT(*) as count
  FROM pg_subscription_rel sr
  JOIN pg_subscription s ON s.oid = sr.srsubid
  $(if [ -n "$SUBSCRIPTION_NAME" ]; then echo "WHERE s.subname = '$SUBSCRIPTION_NAME'"; fi)
  GROUP BY s.subname, sr.srsubstate::text
)
SELECT 
  subname AS "Subscription",
  CASE state
    WHEN 'i' THEN '🔵 Initializing'
    WHEN 'd' THEN '📥 Copying Data'
    WHEN 's' THEN '✅ Synced'
    WHEN 'r' THEN '✅ Ready'
    ELSE state
  END AS "State",
  count AS "Table Count"
FROM table_states
ORDER BY subname, state;
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "3️⃣  REPLICATION LAG ANALYSIS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  subname AS "Subscription",
  CASE 
    WHEN latest_end_time IS NULL THEN '⚠️  No data yet'
    WHEN EXTRACT(EPOCH FROM (NOW() - latest_end_time)) < 60 THEN '✅ < 1 minute'
    WHEN EXTRACT(EPOCH FROM (NOW() - latest_end_time)) < 300 THEN '⚠️  ' || ROUND(EXTRACT(EPOCH FROM (NOW() - latest_end_time)) / 60) || ' minutes'
    ELSE '🔴 ' || ROUND(EXTRACT(EPOCH FROM (NOW() - latest_end_time)) / 60) || ' minutes'
  END AS "Lag",
  ROUND(EXTRACT(EPOCH FROM (NOW() - latest_end_time))::numeric, 2) AS "Lag (seconds)"
FROM pg_stat_subscription
$SUBSCRIPTION_FILTER
ORDER BY EXTRACT(EPOCH FROM (NOW() - latest_end_time)) DESC NULLS FIRST;
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "4️⃣  DATABASE CONFLICTS (Last $TIME_RANGE)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  datname AS "Database",
  confl_tablespace AS "Tablespace Conflicts",
  confl_lock AS "Lock Conflicts",
  confl_snapshot AS "Snapshot Conflicts",
  confl_bufferpin AS "Buffer Pin Conflicts",
  confl_deadlock AS "Deadlocks",
  (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock) AS "Total"
FROM pg_stat_database_conflicts
WHERE datname = current_database();
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "5️⃣  REPLICATION SLOTS ON SOURCE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SLOT_FILTER=""
if [ -n "$SUBSCRIPTION_NAME" ]; then
  SLOT_FILTER="WHERE slot_name = '$SUBSCRIPTION_NAME'"
fi

PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" << EOF
SELECT 
  slot_name AS "Slot Name",
  slot_type AS "Type",
  database AS "Database",
  CASE 
    WHEN active THEN '✅ ACTIVE'
    ELSE '❌ INACTIVE'
  END AS "Status",
  CASE 
    WHEN wal_status = 'reserved' THEN '✅ Reserved'
    WHEN wal_status = 'extended' THEN '⚠️  Extended'
    WHEN wal_status = 'unreserved' THEN '⚠️  Unreserved'
    WHEN wal_status = 'lost' THEN '🔴 LOST'
    ELSE wal_status
  END AS "WAL Status"
FROM pg_replication_slots
$SLOT_FILTER
ORDER BY slot_name;
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "6️⃣  ACTIVE CONNECTIONS TO TARGET DB"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  application_name AS "Application",
  COUNT(*) AS "Connection Count",
  string_agg(DISTINCT state, ', ') AS "States"
FROM pg_stat_activity
WHERE datname = current_database()
  AND application_name IS NOT NULL
  AND application_name != ''
GROUP BY application_name
ORDER BY COUNT(*) DESC
LIMIT 30;
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "7️⃣  TABLES WITH ISSUES (Last $TIME_RANGE)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -n "$SUBSCRIPTION_NAME" ]; then
  PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  sr.srrelid::regclass AS "Table Name",
  CASE sr.srsubstate::text
    WHEN 'i' THEN '🔵 Initializing'
    WHEN 'd' THEN '📥 Copying Data'
    WHEN 's' THEN '✅ Synced'
    WHEN 'r' THEN '✅ Ready'
    ELSE sr.srsubstate::text
  END AS "State"
FROM pg_subscription_rel sr
JOIN pg_subscription s ON s.oid = sr.srsubid
WHERE s.subname = '$SUBSCRIPTION_NAME'
  AND sr.srsubstate::text NOT IN ('r', 's')
ORDER BY sr.srrelid::regclass::text
LIMIT 50;
EOF
else
  echo "Specify a subscription name to see detailed table status"
  echo "Usage: ./scripts/query-replication-logs.sh '$TIME_RANGE' <subscription_name>"
fi

echo ""
echo "=========================================="
echo "✅ Log Query Complete"
echo ""
echo "💡 Tips:"
echo "  - Increase time range: ./scripts/query-replication-logs.sh '24 hours'"
echo "  - Filter subscription: ./scripts/query-replication-logs.sh '1 hour' sub_app_core_large"
echo "  - Check specific periods: ./scripts/query-replication-logs.sh '7 days'"
echo ""
echo "Available time ranges:"
echo "  - '5 minutes', '15 minutes', '30 minutes'"
echo "  - '1 hour', '3 hours', '6 hours', '12 hours', '24 hours'"
echo "  - '2 days', '7 days', '30 days'"
echo ""
