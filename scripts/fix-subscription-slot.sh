#!/bin/bash

# Fix missing replication slot issue
# Usage: ./scripts/fix-subscription-slot.sh [subscription_name]

set -e

SUBSCRIPTION_NAME=${1:-"sub_app_remaining"}

echo "🔧 Fixing replication slot for: $SUBSCRIPTION_NAME"
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

echo "📊 Target: $TARGET_DB_HOST:$TARGET_DB_PORT/$TARGET_DB_NAME"
echo "📊 Source: $SOURCE_DB_HOST:$SOURCE_DB_PORT/$SOURCE_DB_NAME"
echo ""

# Step 1: Disable the subscription temporarily
echo "1️⃣ Disabling subscription..."
PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
ALTER SUBSCRIPTION $SUBSCRIPTION_NAME DISABLE;
EOF

if [ $? -eq 0 ]; then
  echo "   ✅ Subscription disabled"
else
  echo "   ❌ Failed to disable subscription"
  exit 1
fi

# Step 2: Drop the subscription (this will also clean up any broken connection)
echo ""
echo "2️⃣ Dropping subscription (will recreate)..."
PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
DROP SUBSCRIPTION IF EXISTS $SUBSCRIPTION_NAME;
EOF

if [ $? -eq 0 ]; then
  echo "   ✅ Subscription dropped"
else
  echo "   ❌ Failed to drop subscription"
  exit 1
fi

# Step 3: Drop the replication slot on source if it exists (cleanup)
echo ""
echo "3️⃣ Cleaning up old replication slot on source (if exists)..."
PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" << EOF
SELECT pg_drop_replication_slot('$SUBSCRIPTION_NAME')
WHERE EXISTS (
  SELECT 1 FROM pg_replication_slots WHERE slot_name = '$SUBSCRIPTION_NAME'
);
EOF

echo "   ℹ️  Old slot cleaned up (if it existed)"

# Step 4: Get publication name
echo ""
echo "4️⃣ Finding publication name..."
PUBLICATION_NAME="pub_${SUBSCRIPTION_NAME#sub_}"
echo "   📝 Publication: $PUBLICATION_NAME"

# Step 5: Verify publication exists on source
echo ""
echo "5️⃣ Verifying publication exists..."
PUB_EXISTS=$(PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "SELECT COUNT(*) FROM pg_publication WHERE pubname = '$PUBLICATION_NAME';")

if [ "$PUB_EXISTS" -eq "0" ]; then
  echo "   ❌ Publication $PUBLICATION_NAME does not exist on source!"
  echo "   Run: ./scripts/setup-grouped-subscriptions.sh to create it"
  exit 1
else
  echo "   ✅ Publication found: $PUBLICATION_NAME"
fi

# Step 6: Recreate subscription with create_slot=true
echo ""
echo "6️⃣ Recreating subscription with new replication slot..."
CONNECTION_STRING="host=$SOURCE_DB_HOST port=$SOURCE_DB_PORT dbname=$SOURCE_DB_NAME user=$SOURCE_DB_USER password=$SOURCE_DB_PASSWORD"

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
CREATE SUBSCRIPTION $SUBSCRIPTION_NAME
  CONNECTION '$CONNECTION_STRING'
  PUBLICATION $PUBLICATION_NAME
  WITH (
    create_slot = true,
    enabled = true,
    copy_data = true,
    slot_name = '$SUBSCRIPTION_NAME'
  );
EOF

if [ $? -eq 0 ]; then
  echo "   ✅ Subscription recreated successfully!"
else
  echo "   ❌ Failed to recreate subscription"
  exit 1
fi

# Step 7: Verify replication slot was created
echo ""
echo "7️⃣ Verifying replication slot was created..."
sleep 2

PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" << EOF
SELECT 
  slot_name,
  slot_type,
  database,
  active,
  CASE 
    WHEN active THEN '✅ ACTIVE'
    ELSE '⚠️  INACTIVE (starting up)'
  END AS status
FROM pg_replication_slots
WHERE slot_name = '$SUBSCRIPTION_NAME';
EOF

# Step 8: Check worker status
echo ""
echo "8️⃣ Checking subscription worker..."
sleep 1

PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" << EOF
SELECT 
  subname,
  pid,
  CASE 
    WHEN pid IS NULL THEN '❌ NOT RUNNING (starting up...)'
    ELSE '✅ RUNNING'
  END AS status,
  received_lsn,
  latest_end_lsn
FROM pg_stat_subscription
WHERE subname = '$SUBSCRIPTION_NAME';
EOF

echo ""
echo "=========================================="
echo "✅ FIX COMPLETE!"
echo ""
echo "The subscription has been recreated with a new replication slot."
echo ""
echo "What happens next:"
echo "  1. Worker will start (may take a few seconds)"
echo "  2. Tables will initialize"
echo "  3. Data will begin copying"
echo "  4. Replication will continue normally"
echo ""
echo "Monitor progress:"
echo "  - Dashboard: http://localhost:3002/subscriptions"
echo "  - Logs: http://localhost:3002/logs"
echo "  - Or run: ./scripts/check-and-enable-replication.sh"
echo ""
