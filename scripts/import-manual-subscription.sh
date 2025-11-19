#!/bin/sh
# ============================================
# Import Manually Created Subscription
# This script queries PostgreSQL to get subscription details
# and imports them into the monitoring database
# ============================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration from environment (set in pod)
SOURCE_DB_URL="${SOURCE_DATABASE_URL:-postgresql://postgres:CUGlWTwrNSQEQAe1zcFY@10.200.0.24:5432/reya}"
TARGET_DB_URL="${TARGET_DATABASE_URL:-postgresql://postgres:ZKGsMv7ndZhMj7gkXfCP@10.107.240.2:5432/reya}"
MONITORING_DB_HOST="${MONITORING_DB_HOST:-10.107.240.2}"
MONITORING_DB_PORT="${MONITORING_DB_PORT:-5432}"
MONITORING_DB_NAME="${MONITORING_DB_NAME:-replication_monitoring}"
MONITORING_DB_USER="${MONITORING_DB_USER:-postgres}"
MONITORING_DB_PASS="${MONITORING_DB_PASSWORD:-ZKGsMv7ndZhMj7gkXfCP}"

# Parse connection strings
parse_db_url() {
    echo "$1" | sed -n 's/.*:\/\/\([^:]*\):\([^@]*\)@\([^:]*\):\([^\/]*\)\/\([^?]*\).*/\1|\2|\3|\4|\5/p'
}

TARGET_PARTS=$(parse_db_url "$TARGET_DB_URL")
TARGET_USER=$(echo "$TARGET_PARTS" | cut -d'|' -f1)
TARGET_PASS=$(echo "$TARGET_PARTS" | cut -d'|' -f2)
TARGET_HOST=$(echo "$TARGET_PARTS" | cut -d'|' -f3)
TARGET_PORT=$(echo "$TARGET_PARTS" | cut -d'|' -f4)
TARGET_DB=$(echo "$TARGET_PARTS" | cut -d'|' -f5)

SOURCE_PARTS=$(parse_db_url "$SOURCE_DB_URL")
SOURCE_USER=$(echo "$SOURCE_PARTS" | cut -d'|' -f1)
SOURCE_PASS=$(echo "$SOURCE_PARTS" | cut -d'|' -f2)
SOURCE_HOST=$(echo "$SOURCE_PARTS" | cut -d'|' -f3)
SOURCE_PORT=$(echo "$SOURCE_PARTS" | cut -d'|' -f4)
SOURCE_DB=$(echo "$SOURCE_PARTS" | cut -d'|' -f5)

echo "${YELLOW}=== Import Manually Created Subscription ===${NC}"
echo ""
echo "Target DB: ${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}"
echo "Source DB: ${SOURCE_HOST}:${SOURCE_PORT}/${SOURCE_DB}"
echo "Monitoring DB: ${MONITORING_DB_HOST}:${MONITORING_DB_PORT}/${MONITORING_DB_NAME}"
echo ""

# Get subscription name from user or use first argument
if [ -n "$1" ]; then
    SUBSCRIPTION_NAME="$1"
else
    echo "Available subscriptions on target database:"
    export PGPASSWORD="$TARGET_PASS"
    psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -c "
        SELECT subname FROM pg_subscription ORDER BY subname;
    " | sed 's/^[[:space:]]*//' | sed '/^$/d'
    echo ""
    echo "Usage: $0 <subscription_name> [display_name]"
    exit 1
fi

DISPLAY_NAME="${2:-$SUBSCRIPTION_NAME}"

echo "Importing subscription: ${SUBSCRIPTION_NAME}"
echo "Display name: ${DISPLAY_NAME}"
echo ""

# Step 1: Get subscription details from target database
echo "${YELLOW}Step 1: Fetching subscription details...${NC}"
export PGPASSWORD="$TARGET_PASS"
SUBSCRIPTION_INFO=$(psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -A -F '|' <<EOF
SELECT 
    subname,
    subpublications[1],
    COALESCE(subslotname, ''),
    CASE WHEN subenabled THEN 'true' ELSE 'false' END
FROM pg_subscription
WHERE subname = '${SUBSCRIPTION_NAME}';
EOF
)

if [ -z "$SUBSCRIPTION_INFO" ]; then
    echo "${RED}✗ Subscription '${SUBSCRIPTION_NAME}' not found on target database${NC}"
    exit 1
fi

SUBNAME=$(echo "$SUBSCRIPTION_INFO" | cut -d'|' -f1)
PUBLICATION=$(echo "$SUBSCRIPTION_INFO" | cut -d'|' -f2)
SLOT_NAME=$(echo "$SUBSCRIPTION_INFO" | cut -d'|' -f3)
ENABLED=$(echo "$SUBSCRIPTION_INFO" | cut -d'|' -f4)

echo "  Subscription: ${SUBNAME}"
echo "  Publication: ${PUBLICATION}"
echo "  Slot: ${SLOT_NAME}"
echo "  Enabled: ${ENABLED}"
echo ""

# Step 2: Get tables from publication on source database
echo "${YELLOW}Step 2: Fetching tables from publication...${NC}"
export PGPASSWORD="$SOURCE_PASS"
TABLES=$(psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A <<EOF
SELECT tablename 
FROM pg_publication_tables 
WHERE pubname = '${PUBLICATION}'
ORDER BY tablename;
EOF
)

TABLE_COUNT=$(echo "$TABLES" | grep -v '^$' | wc -l | tr -d ' ')
echo "  Found ${TABLE_COUNT} tables in publication"
echo ""

# Step 3: Check if already exists in monitoring database
echo "${YELLOW}Step 3: Checking monitoring database...${NC}"
export PGPASSWORD="$MONITORING_DB_PASS"
EXISTS=$(psql -h "$MONITORING_DB_HOST" -p "$MONITORING_DB_PORT" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" -t -A <<EOF
SELECT COUNT(*) FROM subscriptions WHERE subscription_name = '${SUBSCRIPTION_NAME}';
EOF
)

if [ "$EXISTS" = "1" ]; then
    echo "  ⚠️  Subscription already exists in monitoring database"
    read -p "  Update existing record? (y/N): " UPDATE_EXISTING
    if [ "$UPDATE_EXISTING" != "y" ] && [ "$UPDATE_EXISTING" != "Y" ]; then
        echo "  Skipping import"
        exit 0
    fi
fi

# Step 4: Import subscription
echo "${YELLOW}Step 4: Importing subscription...${NC}"
export PGPASSWORD="$MONITORING_DB_PASS"

# Check if subscription already exists and get ID
EXISTING_ID=$(psql -h "$MONITORING_DB_HOST" -p "$MONITORING_DB_PORT" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" -t -A <<EOF
SELECT id FROM subscriptions WHERE subscription_name = '${SUBSCRIPTION_NAME}' LIMIT 1;
EOF
)

if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "" ]; then
    echo "  Updating existing subscription (ID: ${EXISTING_ID})..."
    SUBSCRIPTION_ID="$EXISTING_ID"
    psql -h "$MONITORING_DB_HOST" -p "$MONITORING_DB_PORT" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" <<EOF > /dev/null
UPDATE subscriptions SET
    name = '${DISPLAY_NAME}',
    description = 'Manually created subscription imported on ' || CURRENT_TIMESTAMP,
    source_db_connection = '${SOURCE_DB_URL}',
    target_db_connection = '${TARGET_DB_URL}',
    publication_name = '${PUBLICATION}',
    slot_name = '${SLOT_NAME}',
    enabled = ${ENABLED},
    updated_at = CURRENT_TIMESTAMP
WHERE id = ${EXISTING_ID};
EOF
else
    echo "  Creating new subscription..."
    SUBSCRIPTION_ID=$(psql -h "$MONITORING_DB_HOST" -p "$MONITORING_DB_PORT" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" -t -A <<EOF
INSERT INTO subscriptions (
    name,
    description,
    source_db_connection,
    target_db_connection,
    publication_name,
    subscription_name,
    slot_name,
    enabled,
    data_copy
) VALUES (
    '${DISPLAY_NAME}',
    'Manually created subscription imported on ' || CURRENT_TIMESTAMP,
    '${SOURCE_DB_URL}',
    '${TARGET_DB_URL}',
    '${PUBLICATION}',
    '${SUBSCRIPTION_NAME}',
    '${SLOT_NAME}',
    ${ENABLED},
    false
)
RETURNING id;
EOF
)
fi

if [ -z "$SUBSCRIPTION_ID" ]; then
    echo "${RED}✗ Failed to import subscription${NC}"
    exit 1
fi

echo "  ✓ Subscription imported with ID: ${SUBSCRIPTION_ID}"
echo ""

# Step 5: Import tables
echo "${YELLOW}Step 5: Importing ${TABLE_COUNT} tables...${NC}"
export PGPASSWORD="$MONITORING_DB_PASS"
for table in $TABLES; do
    if [ -n "$table" ]; then
        psql -h "$MONITORING_DB_HOST" -p "$MONITORING_DB_PORT" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" -t -A <<EOF > /dev/null 2>&1
INSERT INTO subscription_tables (
    subscription_id,
    table_name,
    schema_name,
    enabled
) VALUES (
    '${SUBSCRIPTION_ID}',
    '${table}',
    'public',
    true
)
ON CONFLICT DO NOTHING;
EOF
    fi
done

IMPORTED_COUNT=$(psql -h "$MONITORING_DB_HOST" -p "$MONITORING_DB_PORT" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" -t -A <<EOF
SELECT COUNT(*) FROM subscription_tables WHERE subscription_id = '${SUBSCRIPTION_ID}';
EOF
)

echo "  ✓ Imported ${IMPORTED_COUNT} tables"
echo ""

# Summary
echo "${GREEN}=== Import Complete ===${NC}"
echo ""
echo "Subscription ID: ${SUBSCRIPTION_ID}"
echo "Name: ${DISPLAY_NAME}"
echo "Publication: ${PUBLICATION}"
echo "Slot: ${SLOT_NAME}"
echo "Tables: ${IMPORTED_COUNT}"
echo ""
echo "View in dashboard at: /subscriptions/${SUBSCRIPTION_ID}"
echo ""

