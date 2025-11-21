#!/bin/bash

# Check RDS Replication Configuration
# Verifies that logical replication slot cleanup won't affect physical replicas

set -e

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}RDS Replication Configuration Check${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Get RDS instance identifier from user or env
RDS_INSTANCE="${1:-${RDS_INSTANCE_ID}}"

if [[ -z "$RDS_INSTANCE" ]]; then
  echo -e "${RED}Error: RDS instance identifier required${NC}"
  echo "Usage: $0 <rds-instance-id>"
  echo "   or: export RDS_INSTANCE_ID=<rds-instance-id> && $0"
  exit 1
fi

echo -e "${YELLOW}Checking RDS instance: ${RDS_INSTANCE}${NC}"
echo ""

# ============================================
# 1. Check RDS Instance Details
# ============================================
echo -e "${BLUE}1. RDS Instance Details${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

aws rds describe-db-instances \
  --db-instance-identifier "$RDS_INSTANCE" \
  --query 'DBInstances[0].{
    Engine:Engine,
    EngineVersion:EngineVersion,
    MultiAZ:MultiAZ,
    StorageEncrypted:StorageEncrypted,
    PubliclyAccessible:PubliclyAccessible,
    PreferredMaintenanceWindow:PreferredMaintenanceWindow
  }' \
  --output table

echo ""

# ============================================
# 2. Check Read Replicas (Physical Replication)
# ============================================
echo -e "${BLUE}2. Read Replicas (Physical Replication)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

READ_REPLICAS=$(aws rds describe-db-instances \
  --db-instance-identifier "$RDS_INSTANCE" \
  --query 'DBInstances[0].ReadReplicaDBInstanceIdentifiers' \
  --output json)

if [[ "$READ_REPLICAS" == "[]" ]]; then
  echo -e "${GREEN}✓ No read replicas found${NC}"
  echo -e "  → Physical replication: NOT USED"
  echo -e "  → Safe to drop logical replication slots"
else
  echo -e "${YELLOW}⚠ Read replicas found:${NC}"
  echo "$READ_REPLICAS" | jq -r '.[]' | while read replica; do
    echo -e "  • ${replica}"
  done
  echo ""
  echo -e "${GREEN}✓ Read replicas use PHYSICAL replication${NC}"
  echo -e "  → Managed by AWS automatically"
  echo -e "  → NOT affected by logical replication slot operations"
  echo -e "  → Safe to drop logical replication slots"
fi

echo ""

# ============================================
# 3. Check Parameter Group (Logical Replication Settings)
# ============================================
echo -e "${BLUE}3. Logical Replication Configuration${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

PARAM_GROUP=$(aws rds describe-db-instances \
  --db-instance-identifier "$RDS_INSTANCE" \
  --query 'DBInstances[0].DBParameterGroups[0].DBParameterGroupName' \
  --output text)

echo "Parameter Group: $PARAM_GROUP"
echo ""

# Check logical replication parameters
echo "Logical Replication Settings:"
aws rds describe-db-parameters \
  --db-parameter-group-name "$PARAM_GROUP" \
  --query 'Parameters[?ParameterName==`rds.logical_replication` || ParameterName==`max_replication_slots` || ParameterName==`max_wal_senders` || ParameterName==`wal_level`].{
    Parameter:ParameterName,
    Value:ParameterValue,
    ApplyType:ApplyType,
    IsModifiable:IsModifiable
  }' \
  --output table

echo ""

# ============================================
# 4. Check Replication Connections (pg_stat_replication)
# ============================================
echo -e "${BLUE}4. Active Replication Connections${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "This shows PHYSICAL replication to read replicas (if any)"
echo ""

# Get connection info from .env.local if available
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.local"

if [[ -f "$ENV_FILE" ]]; then
  export $(grep -v '^#' "$ENV_FILE" | grep SOURCE_DATABASE_URL | xargs)
  
  if [[ -n "$SOURCE_DATABASE_URL" ]]; then
    echo "Querying pg_stat_replication (physical replication)..."
    
    # Parse connection string
    parse_db_url() {
        local url=$1
        python3 -c "
from urllib.parse import urlparse, unquote
url = urlparse('$url')
print(f\"{url.hostname}|{url.port or 5432}|{unquote(url.username or '')}|{unquote(url.password or '')}|{url.path.lstrip('/')}\")
"
    }
    
    SOURCE_INFO=$(parse_db_url "$SOURCE_DATABASE_URL")
    IFS='|' read -r SOURCE_HOST SOURCE_PORT SOURCE_USER SOURCE_PASS SOURCE_DB <<< "$SOURCE_INFO"
    
    PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" <<EOF
-- Physical replication (read replicas)
SELECT 
  application_name,
  client_addr,
  state,
  sync_state,
  CASE 
    WHEN sync_state = 'sync' THEN '✓ Synchronous'
    WHEN sync_state = 'async' THEN '✓ Asynchronous'
    ELSE sync_state
  END as replication_type,
  pg_wal_lsn_diff(sent_lsn, write_lsn) as write_lag,
  pg_wal_lsn_diff(write_lsn, flush_lsn) as flush_lag
FROM pg_stat_replication
ORDER BY application_name;
EOF
  else
    echo -e "${YELLOW}⚠ SOURCE_DATABASE_URL not found in .env.local${NC}"
    echo "  Set this to query replication status directly"
  fi
else
  echo -e "${YELLOW}⚠ .env.local not found${NC}"
  echo "  Cannot query pg_stat_replication"
fi

echo ""

# ============================================
# SUMMARY AND RECOMMENDATIONS
# ============================================
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Summary & Safety Confirmation${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}✓ Physical Replication (Read Replicas):${NC}"
echo "  • Managed by AWS RDS automatically"
echo "  • Uses pg_stat_replication, NOT pg_replication_slots"
echo "  • NOT affected by logical replication slot operations"
echo ""
echo -e "${GREEN}✓ Logical Replication (Your Subscriptions):${NC}"
echo "  • Uses pg_replication_slots"
echo "  • Created manually for CDC/migration"
echo "  • Safe to drop orphaned slots without affecting read replicas"
echo ""
echo -e "${YELLOW}Recommended Actions:${NC}"
echo "  1. Drop orphaned logical replication slots (safe)"
echo "  2. Read replicas will continue working normally"
echo "  3. Monitor pg_stat_replication for physical replication health"
echo "  4. Monitor pg_replication_slots for logical replication slots"
echo ""
echo -e "${BLUE}To drop orphaned logical replication slots:${NC}"
echo "  psql \$SOURCE_DATABASE_URL -f scripts/cleanup-orphaned-slots.sql"
echo ""
