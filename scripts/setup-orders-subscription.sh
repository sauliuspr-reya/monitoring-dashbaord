#!/bin/bash
# Setup subscription for orders table with data_copy=true
# Usage: ./setup-orders-subscription.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Setup Orders Subscription with data_copy=true"
echo "=========================================="
echo ""

# Configuration - EDIT THESE VALUES
SUBSCRIPTION_NAME="orders_subscription"
PUBLICATION_NAME="orders_publication"
TABLE_NAME="orders"
SCHEMA_NAME="public"

# Source database connection (where orders table exists)
SOURCE_HOST="${SOURCE_DB_HOST:-localhost}"
SOURCE_PORT="${SOURCE_DB_PORT:-5432}"
SOURCE_DB="${SOURCE_DB_NAME:-your_source_db}"
SOURCE_USER="${SOURCE_DB_USER:-postgres}"
SOURCE_PASS="${SOURCE_DB_PASSWORD:-}"

# Target database connection (where data will be replicated)
TARGET_HOST="${TARGET_DB_HOST:-localhost}"
TARGET_PORT="${TARGET_DB_PORT:-5432}"
TARGET_DB="${TARGET_DB_NAME:-your_target_db}"
TARGET_USER="${TARGET_DB_USER:-postgres}"
TARGET_PASS="${TARGET_DB_PASSWORD:-}"

echo "Configuration:"
echo "  Subscription: $SUBSCRIPTION_NAME"
echo "  Publication: $PUBLICATION_NAME"
echo "  Table: $SCHEMA_NAME.$TABLE_NAME"
echo "  Source: $SOURCE_HOST:$SOURCE_PORT/$SOURCE_DB"
echo "  Target: $TARGET_HOST:$TARGET_PORT/$TARGET_DB"
echo ""

# Prompt for passwords if not set
if [ -z "$SOURCE_PASS" ]; then
  read -sp "Source DB password: " SOURCE_PASS
  echo ""
fi

if [ -z "$TARGET_PASS" ]; then
  read -sp "Target DB password: " TARGET_PASS
  echo ""
fi

# Step 1: Check if publication exists on source
echo -e "${YELLOW}Step 1: Checking publication on source...${NC}"
PUB_EXISTS=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT COUNT(*) FROM pg_publication WHERE pubname = '$PUBLICATION_NAME';
" 2>/dev/null || echo "0")

if [ "$PUB_EXISTS" = "0" ]; then
  echo -e "${YELLOW}Creating publication on source...${NC}"
  PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" <<EOF
    CREATE PUBLICATION $PUBLICATION_NAME FOR TABLE $SCHEMA_NAME.$TABLE_NAME;
    SELECT 'Publication created: ' || pubname FROM pg_publication WHERE pubname = '$PUBLICATION_NAME';
EOF
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Publication created${NC}"
  else
    echo -e "${RED}✗ Failed to create publication${NC}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ Publication already exists${NC}"
  
  # Check if table is in publication
  TABLE_IN_PUB=$(PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
    SELECT COUNT(*) FROM pg_publication_tables 
    WHERE pubname = '$PUBLICATION_NAME' AND tablename = '$TABLE_NAME';
  " 2>/dev/null || echo "0")
  
  if [ "$TABLE_IN_PUB" = "0" ]; then
    echo -e "${YELLOW}Adding table to publication...${NC}"
    PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" <<EOF
      ALTER PUBLICATION $PUBLICATION_NAME ADD TABLE $SCHEMA_NAME.$TABLE_NAME;
EOF
    echo -e "${GREEN}✓ Table added to publication${NC}"
  fi
fi

# Step 2: Check if subscription exists on target
echo ""
echo -e "${YELLOW}Step 2: Checking subscription on target...${NC}"
SUB_EXISTS=$(PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -A -c "
  SELECT COUNT(*) FROM pg_subscription WHERE subname = '$SUBSCRIPTION_NAME';
" 2>/dev/null || echo "0")

if [ "$SUB_EXISTS" != "0" ]; then
  echo -e "${RED}✗ Subscription '$SUBSCRIPTION_NAME' already exists!${NC}"
  echo "Options:"
  echo "  1. Drop existing subscription: DROP SUBSCRIPTION $SUBSCRIPTION_NAME;"
  echo "  2. Use a different subscription name"
  read -p "Drop existing subscription? (y/N): " DROP_SUB
  if [ "$DROP_SUB" = "y" ] || [ "$DROP_SUB" = "Y" ]; then
    echo -e "${YELLOW}Dropping existing subscription...${NC}"
    PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" <<EOF
      DROP SUBSCRIPTION IF EXISTS $SUBSCRIPTION_NAME;
EOF
    echo -e "${GREEN}✓ Subscription dropped${NC}"
  else
    echo "Exiting. Please drop subscription manually or use different name."
    exit 1
  fi
fi

# Step 3: Create subscription on target
echo ""
echo -e "${YELLOW}Step 3: Creating subscription on target with data_copy=true...${NC}"

# Build connection string for subscription
CONN_STRING="host=$SOURCE_HOST port=$SOURCE_PORT dbname=$SOURCE_DB user=$SOURCE_USER password=$SOURCE_PASS"

# Escape single quotes in connection string
ESCAPED_CONN=$(echo "$CONN_STRING" | sed "s/'/''/g")

PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" <<EOF
  CREATE SUBSCRIPTION $SUBSCRIPTION_NAME
  CONNECTION '$ESCAPED_CONN'
  PUBLICATION $PUBLICATION_NAME
  WITH (
    create_slot = true,
    slot_name = '$SUBSCRIPTION_NAME',
    copy_data = true,
    enabled = true,
    streaming = parallel
  );
EOF

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ Subscription created with data_copy=true${NC}"
else
  echo -e "${RED}✗ Failed to create subscription${NC}"
  exit 1
fi

# Step 4: Verify subscription
echo ""
echo -e "${YELLOW}Step 4: Verifying subscription...${NC}"
PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" <<EOF
  SELECT 
    'Subscription Status' as check_type,
    subname,
    CASE WHEN subenabled THEN 'Enabled' ELSE 'Disabled' END as status
  FROM pg_subscription
  WHERE subname = '$SUBSCRIPTION_NAME';
EOF

# Step 5: Check copy state
echo ""
echo -e "${YELLOW}Step 5: Checking copy state...${NC}"
PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" <<EOF
  SELECT 
    c.relname as table_name,
    sr.srsubstate as copy_state,
    CASE sr.srsubstate
      WHEN 'i' THEN '🔄 Initializing (copy in progress)'
      WHEN 'd' THEN '✅ Data copy done'
      WHEN 's' THEN '🔄 Synchronizing (applying changes)'
      WHEN 'r' THEN '✅ Ready'
      ELSE '❓ Unknown'
    END as status
  FROM pg_subscription s
  JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
  JOIN pg_class c ON sr.srrelid = c.oid
  WHERE s.subname = '$SUBSCRIPTION_NAME' AND c.relname = '$TABLE_NAME';
EOF

# Step 6: Show initial row counts
echo ""
echo -e "${YELLOW}Step 6: Initial row counts...${NC}"
echo "Source (approximate):"
PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "
  SELECT reltuples::bigint as source_rows 
  FROM pg_class 
  WHERE relname = '$TABLE_NAME';
" 2>/dev/null || echo "Unable to get source count"

echo "Target (approximate):"
PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -A -c "
  SELECT reltuples::bigint as target_rows 
  FROM pg_class 
  WHERE relname = '$TABLE_NAME';
" 2>/dev/null || echo "Unable to get target count"

echo ""
echo -e "${GREEN}=========================================="
echo "✓ Setup Complete!"
echo "==========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. Monitor copy progress: Check pg_subscription_rel.srsubstate"
echo "  2. Use dashboard: Navigate to /subscriptions to view progress"
echo "  3. Check row counts periodically to track progress"
echo ""
echo "To monitor copy state:"
echo "  psql -h $TARGET_HOST -U $TARGET_USER -d $TARGET_DB -c \""
echo "    SELECT c.relname, sr.srsubstate FROM pg_subscription_rel sr"
echo "    JOIN pg_class c ON sr.srrelid = c.oid"
echo "    WHERE c.relname = '$TABLE_NAME';"
echo "  \""
echo ""

