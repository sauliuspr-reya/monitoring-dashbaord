#!/bin/bash
set -euo pipefail

# Script to check and free up replication slots
# For AWS (Source) → GCP (Target) replication

echo "========================================="
echo "Replication Slot Management"
echo "AWS (Source) → GCP (Target)"
echo "========================================="
echo ""

# Check for required environment variables
if [[ -z "${SOURCE_DATABASE_URL:-}" ]]; then
    echo "❌ Error: SOURCE_DATABASE_URL environment variable is not set"
    echo "   Set it to your AWS RDS connection string"
    exit 1
fi

if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
    echo "❌ Error: TARGET_DATABASE_URL environment variable is not set"
    echo "   Set it to your GCP Cloud SQL connection string"
    exit 1
fi

# Parse connection strings
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

echo "AWS Source (RDS):  ${SOURCE_HOST}:${SOURCE_PORT}/${SOURCE_DB}"
echo "GCP Target (Cloud SQL):  ${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}"
echo ""

# Function to run query on source (AWS)
run_source_query() {
    PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -t -A -c "$1" 2>/dev/null || echo ""
}

# Function to run query on target (GCP)
run_target_query() {
    PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -A -c "$1" 2>/dev/null || echo ""
}

# Function to run formatted query on source
run_source_query_formatted() {
    PGPASSWORD="$SOURCE_PASS" psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" -c "$1" 2>/dev/null || echo ""
}

# Function to run formatted query on target
run_target_query_formatted() {
    PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -c "$1" 2>/dev/null || echo ""
}

echo "========================================="
echo "STEP 1: Check Subscriptions on GCP (TARGET)"
echo "========================================="
echo ""

SUBSCRIPTIONS=$(run_target_query "
SELECT 
    subname || '|' ||
    COALESCE(subslotname, 'NULL') || '|' ||
    CASE WHEN subenabled THEN 'enabled' ELSE 'disabled' END
FROM pg_subscription
ORDER BY subname;
")

if [[ -z "$SUBSCRIPTIONS" ]]; then
    echo "✓ No subscriptions found on GCP (target)"
else
    echo "Found subscriptions:"
    echo "$SUBSCRIPTIONS" | while IFS='|' read -r sub_name slot_name enabled; do
        echo "  - $sub_name (slot: $slot_name, status: $enabled)"
    done
fi

echo ""
echo "Detailed subscription status:"
run_target_query_formatted "
SELECT 
    s.subname as subscription_name,
    s.subenabled as enabled,
    s.subslotname as slot_name_on_aws,
    COALESCE(stat.pid::text, 'no_worker') as worker_pid,
    COALESCE(stat.state, 'N/A') as worker_state
FROM pg_subscription s
LEFT JOIN pg_stat_subscription stat ON s.subname = stat.subname
ORDER BY s.subname;
"

echo ""
echo "========================================="
echo "STEP 2: Check Replication Slots on AWS (SOURCE)"
echo "========================================="
echo ""

# Check max slots and current usage
SLOT_COUNT=$(run_source_query "
SELECT 
    COUNT(*)::text || '|' ||
    COUNT(*) FILTER (WHERE active)::text || '|' ||
    COUNT(*) FILTER (WHERE NOT active)::text || '|' ||
    (SELECT setting FROM pg_settings WHERE name = 'max_replication_slots') || '|' ||
    ((SELECT setting::int FROM pg_settings WHERE name = 'max_replication_slots') - COUNT(*))::text
FROM pg_replication_slots;
")

IFS='|' read -r total_slots active_slots inactive_slots max_slots available_slots <<< "$SLOT_COUNT"

echo "Slot Summary:"
echo "  Total slots: $total_slots"
echo "  Active slots: $active_slots"
echo "  Inactive slots: $inactive_slots"
echo "  Max slots: $max_slots"
echo "  Available slots: $available_slots"
echo ""

if [[ "$available_slots" -le 0 ]]; then
    echo "⚠️  WARNING: All replication slots are in use!"
    echo ""
fi

echo "All replication slots:"
run_source_query_formatted "
SELECT 
    slot_name,
    slot_type,
    CASE WHEN active THEN 'ACTIVE' ELSE 'INACTIVE' END as status,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as wal_lag
FROM pg_replication_slots
ORDER BY active DESC, slot_name;
"

echo ""
echo "Inactive slots (can be dropped if orphaned):"
INACTIVE_SLOTS=$(run_source_query "
SELECT slot_name || '|' || pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
FROM pg_replication_slots
WHERE NOT active
ORDER BY slot_name;
")

if [[ -z "$INACTIVE_SLOTS" ]]; then
    echo "  (none)"
else
    echo "$INACTIVE_SLOTS" | while IFS='|' read -r slot_name wal_lag; do
        echo "  - $slot_name (WAL lag: $wal_lag)"
    done
fi

echo ""
echo "========================================="
echo "STEP 3: Generate Drop Commands"
echo "========================================="
echo ""

# Generate drop commands for subscriptions on GCP
echo "Drop commands for subscriptions (run on GCP TARGET):"
SUBSCRIPTION_DROPS=$(run_target_query "
SELECT 'DROP SUBSCRIPTION IF EXISTS ' || subname || ';'
FROM pg_subscription
ORDER BY subname;
")

if [[ -z "$SUBSCRIPTION_DROPS" ]]; then
    echo "  (no subscriptions to drop)"
else
    echo "$SUBSCRIPTION_DROPS" | while read -r cmd; do
        echo "  $cmd"
    done
fi

echo ""
echo "Drop commands for inactive slots (run on AWS SOURCE):"
SLOT_DROPS=$(run_source_query "
SELECT 'SELECT pg_drop_replication_slot(''' || slot_name || ''');'
FROM pg_replication_slots
WHERE NOT active
ORDER BY slot_name;
")

if [[ -z "$SLOT_DROPS" ]]; then
    echo "  (no inactive slots to drop)"
else
    echo "$SLOT_DROPS" | while read -r cmd; do
        echo "  $cmd"
    done
fi

echo ""
echo "========================================="
echo "STEP 4: Execute Drop Commands?"
echo "========================================="
echo ""

if [[ "$available_slots" -gt 0 ]]; then
    echo "✓ You have $available_slots available slot(s). No action needed."
    exit 0
fi

echo "⚠️  All slots are in use. You need to free some slots."
echo ""
read -p "Do you want to drop inactive slots on AWS? (yes/no): " -r
echo ""

if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Cancelled. No slots were dropped."
    echo ""
    echo "To manually drop slots, run the commands shown above."
    exit 0
fi

# Drop inactive slots on AWS
if [[ -n "$SLOT_DROPS" ]]; then
    echo "Dropping inactive slots on AWS (SOURCE)..."
    echo "$SLOT_DROPS" | while read -r cmd; do
        echo "  Executing: $cmd"
        run_source_query "$cmd" || echo "    ⚠️  Failed to drop slot"
    done
    echo "✓ Done dropping inactive slots"
else
    echo "No inactive slots to drop on AWS"
fi

echo ""
echo "========================================="
echo "Final Status"
echo "========================================="
echo ""

# Check final slot count
FINAL_SLOT_COUNT=$(run_source_query "
SELECT 
    COUNT(*)::text || '|' ||
    (SELECT setting FROM pg_settings WHERE name = 'max_replication_slots') || '|' ||
    ((SELECT setting::int FROM pg_settings WHERE name = 'max_replication_slots') - COUNT(*))::text
FROM pg_replication_slots;
")

IFS='|' read -r final_total final_max final_available <<< "$FINAL_SLOT_COUNT"

echo "Final slot status:"
echo "  Total slots: $final_total / $final_max"
echo "  Available slots: $final_available"
echo ""

if [[ "$final_available" -gt 0 ]]; then
    echo "✓ Success! You now have $final_available available slot(s)."
else
    echo "⚠️  Still no available slots. You may need to:"
    echo "   1. Drop subscriptions on GCP (target) first"
    echo "   2. Increase max_replication_slots on AWS (source)"
fi

echo ""
echo "Done!"

