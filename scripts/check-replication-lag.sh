#!/bin/bash

# Check replication lag and subscription status
# Reads connection strings from .env.local

set -e

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.local"

# Load .env.local
if [[ ! -f "$ENV_FILE" ]]; then
  echo -e "${RED}Error: .env.local not found${NC}"
  exit 1
fi

export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)

# Parse connection strings
parse_db_url() {
    local url=$1
    python3 -c "
from urllib.parse import urlparse, unquote
url = urlparse('$url')
print(f\"{url.hostname}|{url.port or 5432}|{unquote(url.username or '')}|{unquote(url.password or '')}|{url.path.lstrip('/')}\")
"
}

TARGET_INFO=$(parse_db_url "$TARGET_DATABASE_URL")
IFS='|' read -r TARGET_HOST TARGET_PORT TARGET_USER TARGET_PASS TARGET_DB <<< "$TARGET_INFO"

SOURCE_INFO=$(parse_db_url "$SOURCE_DATABASE_URL")
IFS='|' read -r SOURCE_HOST SOURCE_PORT SOURCE_USER SOURCE_PASS SOURCE_DB <<< "$SOURCE_INFO"

TABLE_NAME="${1:-orders}"

echo -e "${BLUE}Checking replication lag for table: $TABLE_NAME${NC}"
echo ""

# Check subscription lag on TARGET
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Replication Lag (TARGET)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" <<EOF
SELECT 
  subname as subscription_name,
  pid as worker_pid,
  received_lsn,
  latest_end_lsn,
  latest_end_time,
  last_msg_send_time,
  last_msg_receipt_time
FROM pg_stat_subscription
WHERE subname LIKE '%main%' OR subname LIKE '%orders%';
EOF

echo ""

# Check slot lag on SOURCE
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Slot Lag (SOURCE)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" <<EOF
SELECT 
  slot_name,
  active,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as slot_lag,
  pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as slot_lag_bytes,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) as confirmed_lag
FROM pg_replication_slots
WHERE slot_name LIKE '%main%' OR slot_name LIKE '%orders%'
ORDER BY slot_name;
EOF

echo ""

# Check table-level replication status
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Table Replication Status (TARGET)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" <<EOF
SELECT 
  s.subname as subscription_name,
  c.relname as table_name,
  sr.srsubstate as state_code,
  CASE sr.srsubstate
    WHEN 'i' THEN 'Initializing'
    WHEN 'd' THEN 'Data copy done'
    WHEN 's' THEN 'Synchronizing'
    WHEN 'r' THEN 'Ready'
    ELSE 'Unknown'
  END as state,
  sr.srsublsn as last_replicated_lsn
FROM pg_subscription s
JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
JOIN pg_class c ON sr.srrelid = c.oid
WHERE c.relname = '$TABLE_NAME'
ORDER BY s.subname;
EOF

echo ""
echo -e "${GREEN}✓ Replication lag check complete${NC}"
echo ""
echo -e "${YELLOW}Interpretation:${NC}"
echo "- If lag is small (< 1GB): Subscription is catching up normally"
echo "- If lag is large (> 10GB): Subscription may be struggling"
echo "- If worker_state = 'catchup': Subscription is actively catching up"
echo "- If worker_state = 'streaming': Subscription is in sync"

