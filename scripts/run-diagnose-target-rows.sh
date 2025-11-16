#!/bin/bash

# ============================================
# Diagnose: Why Target Has More Rows Than Source
# Reads connection strings from .env.local
# ============================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.local"
SQL_SCRIPT="$SCRIPT_DIR/diagnose-target-more-rows.sql"

# Check if .env.local exists
if [[ ! -f "$ENV_FILE" ]]; then
  echo -e "${RED}Error: .env.local not found at $ENV_FILE${NC}"
  exit 1
fi

# Check if SQL script exists
if [[ ! -f "$SQL_SCRIPT" ]]; then
  echo -e "${RED}Error: SQL script not found at $SQL_SCRIPT${NC}"
  exit 1
fi

# Source .env.local
echo -e "${BLUE}Loading connection strings from .env.local...${NC}"
export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)

# Extract connection details
if [[ -z "$SOURCE_DATABASE_URL" ]]; then
  echo -e "${RED}Error: SOURCE_DATABASE_URL not found in .env.local${NC}"
  exit 1
fi

if [[ -z "$TARGET_DATABASE_URL" ]]; then
  echo -e "${RED}Error: TARGET_DATABASE_URL not found in .env.local${NC}"
  exit 1
fi

# Parse connection strings using Python (more reliable)
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

TARGET_INFO=$(parse_db_url "$TARGET_DATABASE_URL")
IFS='|' read -r TARGET_HOST TARGET_PORT TARGET_USER TARGET_PASS TARGET_DB <<< "$TARGET_INFO"

# Validate parsed values
if [[ -z "$SOURCE_USER" || -z "$SOURCE_HOST" || -z "$SOURCE_DB" ]]; then
  echo -e "${RED}Error: Could not parse SOURCE_DATABASE_URL${NC}"
  echo "Expected format: postgresql://user:pass@host:port/db"
  exit 1
fi

if [[ -z "$TARGET_USER" || -z "$TARGET_HOST" || -z "$TARGET_DB" ]]; then
  echo -e "${RED}Error: Could not parse TARGET_DATABASE_URL${NC}"
  echo "Expected format: postgresql://user:pass@host:port/db"
  exit 1
fi

echo -e "${GREEN}✓ Connection strings parsed${NC}"
echo ""
echo -e "${BLUE}Source:${NC} $SOURCE_USER@$SOURCE_HOST:$SOURCE_PORT/$SOURCE_DB"
echo -e "${BLUE}Target:${NC} $TARGET_USER@$TARGET_HOST:$TARGET_PORT/$TARGET_DB"
echo ""

# Get table name from command line argument or default to 'orders'
TABLE_NAME="${1:-orders}"

echo ""
echo -e "${YELLOW}===========================================${NC}"
echo -e "${YELLOW}Running Diagnostics for table: $TABLE_NAME${NC}"
echo -e "${YELLOW}===========================================${NC}"
echo ""

# Function to run SQL on target
run_on_target() {
  local query="$1"
  local description="$2"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}TARGET: $description${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -c "$query" 2>&1 || echo "Query failed"
  echo ""
}

# Function to run SQL on source
run_on_source() {
  local query="$1"
  local description="$2"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}SOURCE: $description${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -c "$query" 2>&1 || echo "Query failed"
  echo ""
}

# PART 1: Check Subscription Configuration (TARGET)
run_on_target "
SELECT 
  'SUBSCRIPTION CONFIG' as check_type,
  subname as subscription_name,
  subenabled as enabled,
  subpublications as publications,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_subscription_rel sr
      JOIN pg_class c ON sr.srrelid = c.oid
      WHERE sr.srsubid = s.oid 
        AND sr.srsubstate = 'i'
    ) THEN '⚠️ COPY IN PROGRESS - copy_data may have been true!'
    ELSE '✓ No active copy (copy_data was likely false)'
  END as copy_status
FROM pg_subscription s
ORDER BY subname;
" "Subscription Configuration"

# PART 2: Check Table Copy State (TARGET)
run_on_target "
SELECT 
  'TABLE COPY STATE' as check_type,
  s.subname as subscription_name,
  c.relname as table_name,
  sr.srsubstate as state_code,
  CASE sr.srsubstate
    WHEN 'i' THEN '⚠️ INITIALIZING (copying data) - This means copy_data=true was used!'
    WHEN 'd' THEN '✅ DATA COPY DONE'
    WHEN 's' THEN '🔄 SYNCHRONIZING (applying changes)'
    WHEN 'r' THEN '✅ READY (replicating)'
    ELSE '❓ UNKNOWN'
  END as state_description
FROM pg_subscription s
JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
JOIN pg_class c ON sr.srrelid = c.oid
WHERE c.relname = '$TABLE_NAME'
ORDER BY s.subname;
" "Table Copy State for $TABLE_NAME"

# PART 3: Check for Writes on TARGET
run_on_target "
SELECT 
  'ACTIVE WRITERS ON TARGET' as check_type,
  pid,
  usename,
  application_name,
  client_addr,
  state,
  query_start,
  LEFT(query, 100) as query_preview
FROM pg_stat_activity
WHERE (
  query ILIKE '%INSERT%$TABLE_NAME%'
  OR query ILIKE '%UPDATE%$TABLE_NAME%'
  OR query ILIKE '%DELETE%$TABLE_NAME%'
  OR query ILIKE '%COPY%$TABLE_NAME%'
)
AND state != 'idle'
AND pid != pg_backend_pid()
ORDER BY query_start DESC;
" "Active Writers on TARGET for $TABLE_NAME"

# PART 4: Check Replication Worker
run_on_target "
SELECT 
  'REPLICATION WORKER' as check_type,
  pid,
  usename,
  application_name,
  state,
  query_start,
  LEFT(query, 100) as query_preview
FROM pg_stat_activity
WHERE application_name LIKE '%subscription%'
   OR application_name LIKE '%replication%'
   OR application_name LIKE '%logical%'
ORDER BY query_start DESC;
" "Replication Worker Activity"

# PART 5: Compare Row Counts
run_on_source "
SELECT 
  'SOURCE ROW COUNT' as check_type,
  '$TABLE_NAME' as table_name,
  reltuples::bigint as estimated_rows,
  pg_size_pretty(pg_relation_size('$TABLE_NAME'::regclass)) as table_size,
  pg_size_pretty(pg_indexes_size('$TABLE_NAME'::regclass)) as index_size
FROM pg_class
WHERE relname = '$TABLE_NAME'
  AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
" "Source Row Count (Estimate) for $TABLE_NAME"

run_on_target "
SELECT 
  'TARGET ROW COUNT' as check_type,
  '$TABLE_NAME' as table_name,
  reltuples::bigint as estimated_rows,
  pg_size_pretty(pg_relation_size('$TABLE_NAME'::regclass)) as table_size,
  pg_size_pretty(pg_indexes_size('$TABLE_NAME'::regclass)) as index_size
FROM pg_class
WHERE relname = '$TABLE_NAME'
  AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
" "Target Row Count (Estimate) for $TABLE_NAME"

# PART 6: Check Replication Slot Status (SOURCE)
run_on_source "
SELECT 
  'REPLICATION SLOT STATUS' as check_type,
  slot_name,
  slot_type,
  active,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as wal_lag,
  pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as wal_lag_bytes
FROM pg_replication_slots
ORDER BY slot_name;
" "Replication Slot Status on SOURCE"

echo ""
echo -e "${GREEN}===========================================${NC}"
echo -e "${GREEN}Diagnostics Complete${NC}"
echo -e "${GREEN}===========================================${NC}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "1. If state_code = 'i' (INITIALIZING): copy_data=true was used - drop and recreate subscription"
echo "2. If active writers found on TARGET: stop writes or accept discrepancy"
echo "3. If replication worker is active: subscription is replicating changes (normal)"
echo "4. For exact row counts, run: SELECT COUNT(*) FROM $TABLE_NAME; on both databases"
echo ""

