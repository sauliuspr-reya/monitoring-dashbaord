#!/bin/bash

# Diagnose and fix subscription connection errors
# Usage: ./scripts/diagnose-subscription-error.sh [subscription_name]

set -e

SUBSCRIPTION_NAME=${1:-"sub_app_remaining"}

echo "🔍 Diagnosing subscription: $SUBSCRIPTION_NAME"
echo "=========================================="
echo ""

# Load environment variables
if [ -f .env.local ]; then
  source .env.local
else
  echo "❌ Error: .env.local not found"
  exit 1
fi

# Parse connection strings
SOURCE_DB_URL="${SOURCE_DATABASE_URL}"
TARGET_DB_URL="${TARGET_DATABASE_URL}"

# Extract connection details with URL decoding
SOURCE_DB_HOST=$(echo "$SOURCE_DB_URL" | sed 's/.*@\([^:]*\):.*/\1/')
SOURCE_DB_PORT=$(echo "$SOURCE_DB_URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
SOURCE_DB_NAME=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\([^?]*\).*/\1/')
SOURCE_DB_USER=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\/\([^:]*\):.*/\1/')
SOURCE_DB_PASSWORD=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\/[^:]*:\([^@]*\)@.*/\1/' | sed 's/%24/$/g' | sed 's/%3D/=/g')

TARGET_DB_HOST=$(echo "$TARGET_DB_URL" | sed 's/.*@\([^:]*\):.*/\1/')
TARGET_DB_PORT=$(echo "$TARGET_DB_URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
TARGET_DB_NAME=$(echo "$TARGET_DB_URL" | sed 's/.*\/\([^?]*\).*/\1/')
TARGET_DB_USER=$(echo "$TARGET_DB_URL" | sed 's/.*\/\/\([^:]*\):.*/\1/')
TARGET_DB_PASSWORD=$(echo "$TARGET_DB_URL" | sed 's/.*\/\/[^:]*:\([^@]*\)@.*/\1/' | sed 's/%24/$/g' | sed 's/%3D/=/g')

echo "📊 Connection Details:"
echo "  Source: $SOURCE_DB_HOST:$SOURCE_DB_PORT/$SOURCE_DB_NAME"
echo "  Target: $TARGET_DB_HOST:$TARGET_DB_PORT/$TARGET_DB_NAME"
echo ""

# Test source database connection
echo "1️⃣ Testing SOURCE database connection..."
if PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
  echo "   ✅ Source database: Connected"
else
  echo "   ❌ Source database: Connection FAILED"
  echo "   Check:"
  echo "     - Host reachable: ping $SOURCE_DB_HOST"
  echo "     - Port open: nc -zv $SOURCE_DB_HOST $SOURCE_DB_PORT"
  echo "     - Credentials correct"
  exit 1
fi

# Test target database connection
echo "2️⃣ Testing TARGET database connection..."
if PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
  echo "   ✅ Target database: Connected"
else
  echo "   ❌ Target database: Connection FAILED"
  echo "   Check:"
  echo "     - Host reachable: ping $TARGET_DB_HOST"
  echo "     - Port open: nc -zv $TARGET_DB_HOST $TARGET_DB_PORT"
  echo "     - Credentials correct"
  exit 1
fi

echo ""
echo "3️⃣ Checking subscription status on TARGET..."
PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  subname AS subscription,
  subenabled AS enabled,
  (SELECT pid FROM pg_stat_subscription WHERE subid = s.oid) AS worker_pid,
  subconninfo AS connection_info
FROM pg_subscription s
WHERE subname = '$SUBSCRIPTION_NAME';
EOF

echo ""
echo "4️⃣ Checking subscription worker status..."
PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  subname,
  pid,
  received_lsn,
  latest_end_lsn,
  latest_end_time,
  CASE 
    WHEN pid IS NULL THEN '❌ NOT RUNNING'
    ELSE '✅ RUNNING'
  END AS status
FROM pg_stat_subscription
WHERE subname = '$SUBSCRIPTION_NAME';
EOF

echo ""
echo "5️⃣ Checking replication slot on SOURCE..."
PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" << EOF
SELECT 
  slot_name,
  slot_type,
  database,
  active,
  wal_status,
  CASE 
    WHEN active THEN '✅ ACTIVE'
    ELSE '❌ INACTIVE'
  END AS status
FROM pg_replication_slots
WHERE slot_name = '$SUBSCRIPTION_NAME';
EOF

echo ""
echo "6️⃣ Checking PostgreSQL logs for errors..."
PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
-- Check for recent errors in pg_stat_activity
SELECT 
  pid,
  usename,
  application_name,
  state,
  wait_event_type,
  wait_event,
  backend_start,
  query
FROM pg_stat_activity
WHERE application_name = '$SUBSCRIPTION_NAME'
   OR query LIKE '%$SUBSCRIPTION_NAME%';
EOF

echo ""
echo "7️⃣ Checking table replication states..."
PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  sr.srrelid::regclass AS table_name,
  CASE sr.srsubstate::text
    WHEN 'i' THEN '🔵 Initializing'
    WHEN 'd' THEN '📥 Copying Data'
    WHEN 's' THEN '✅ Synced'
    WHEN 'r' THEN '✅ Ready'
    ELSE sr.srsubstate::text
  END AS state
FROM pg_subscription_rel sr
JOIN pg_subscription s ON s.oid = sr.srsubid
WHERE s.subname = '$SUBSCRIPTION_NAME'
ORDER BY sr.srrelid::regclass::text
LIMIT 20;
EOF

echo ""
echo "========================================"
echo "🔧 Suggested Fixes:"
echo ""
echo "If worker is NOT RUNNING:"
echo "  1. Check connection string in subscription"
echo "  2. Verify network connectivity between databases"
echo "  3. Check firewall rules"
echo "  4. Try enabling the subscription:"
echo "     ALTER SUBSCRIPTION $SUBSCRIPTION_NAME ENABLE;"
echo ""
echo "If replication slot is INACTIVE:"
echo "  1. Check if slot exists on source"
echo "  2. Verify slot is active"
echo "  3. May need to refresh subscription:"
echo "     ALTER SUBSCRIPTION $SUBSCRIPTION_NAME REFRESH PUBLICATION;"
echo ""
echo "If connection string is wrong:"
echo "  1. Update subscription connection:"
echo "     ALTER SUBSCRIPTION $SUBSCRIPTION_NAME CONNECTION 'postgresql://...'"
echo "  2. Then refresh:"
echo "     ALTER SUBSCRIPTION $SUBSCRIPTION_NAME REFRESH PUBLICATION;"
echo ""
echo "To completely recreate (last resort):"
echo "  1. Drop subscription: DROP SUBSCRIPTION $SUBSCRIPTION_NAME;"
echo "  2. Re-run setup: ./scripts/setup-grouped-subscriptions.sh"
echo ""
