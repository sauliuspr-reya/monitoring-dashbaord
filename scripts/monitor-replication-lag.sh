#!/bin/bash

# Monitor replication progress using WAL lag and subscription metrics (NO COUNT(*) queries)
# Usage: ./scripts/monitor-replication-lag.sh [subscription_name] [interval_seconds]

set -euo pipefail

SUBSCRIPTION_NAME="${1:-}"
INTERVAL="${2:-30}"

# Load environment variables from .env.local
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '^#' | xargs)
fi

SOURCE_CONNECTION_STRING="${SOURCE_DATABASE_URL}"
TARGET_CONNECTION_STRING="${TARGET_DATABASE_URL}"

if [ -z "$SOURCE_CONNECTION_STRING" ] || [ -z "$TARGET_CONNECTION_STRING" ]; then
  echo "Error: SOURCE_DATABASE_URL and TARGET_DATABASE_URL must be set in .env.local"
  exit 1
fi

# If subscription name not provided, try to find one
if [ -z "$SUBSCRIPTION_NAME" ]; then
  echo "Finding active subscriptions..."
  SUBSCRIPTION_NAME=$(psql "$TARGET_CONNECTION_STRING" -t -A -c "
    SELECT subname 
    FROM pg_subscription 
    WHERE subenabled = true 
    LIMIT 1
  " 2>/dev/null | tr -d ' \n\r' || echo "")
  
  if [ -z "$SUBSCRIPTION_NAME" ]; then
    echo "Error: No active subscription found. Please specify subscription name."
    echo "Usage: $0 [subscription_name] [interval_seconds]"
    exit 1
  fi
  echo "Using subscription: $SUBSCRIPTION_NAME"
fi

echo "Monitoring replication lag for subscription: $SUBSCRIPTION_NAME"
echo "Update interval: ${INTERVAL} seconds"
echo "Using WAL lag metrics (NO COUNT(*) queries - fast and CPU-friendly)"
echo "Press Ctrl+C to stop"
echo ""

# Function to get subscription lag metrics
get_subscription_metrics() {
  local conn_string="$1"
  local sub_name="$2"
  local result
  set +e
  result=$(psql "$conn_string" -t -A -F'|' -c "
    SELECT 
      COALESCE(ss.pid::text, 'NULL') as worker_pid,
      COALESCE(ss.received_lsn::text, 'NULL') as received_lsn,
      COALESCE(ss.latest_end_lsn::text, 'NULL') as latest_end_lsn,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - ss.latest_end_time))::bigint, 0) as lag_seconds,
      COALESCE(ss.latest_end_time::text, 'NULL') as latest_end_time,
      COALESCE(ss.last_msg_send_time::text, 'NULL') as last_msg_send_time,
      COALESCE(ss.last_msg_receipt_time::text, 'NULL') as last_msg_receipt_time
    FROM pg_subscription s
    LEFT JOIN pg_stat_subscription ss ON s.oid = ss.subid
    WHERE s.subname = '$sub_name'
    LIMIT 1
  " 2>&1)
  local exit_code=$?
  set -e
  if [ $exit_code -ne 0 ]; then
    echo "ERROR"
    return 0
  fi
  echo "$result"
}

# Function to get slot lag on source
get_slot_lag() {
  local conn_string="$1"
  local slot_name="$2"
  local result
  set +e
  result=$(psql "$conn_string" -t -A -F'|' -c "
    SELECT 
      COALESCE(active::text, 'false') as active,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint, 0) as slot_lag_bytes,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint, 0) as confirmed_lag_bytes,
      COALESCE(restart_lsn::text, 'NULL') as restart_lsn,
      COALESCE(confirmed_flush_lsn::text, 'NULL') as confirmed_flush_lsn
    FROM pg_replication_slots
    WHERE slot_name = '$slot_name'
    LIMIT 1
  " 2>&1)
  local exit_code=$?
  set -e
  if [ $exit_code -ne 0 ]; then
    echo "ERROR"
    return 0
  fi
  echo "$result"
}

# Function to get table sync status
get_table_sync_status() {
  local conn_string="$1"
  local sub_name="$2"
  local result
  set +e
  result=$(psql "$conn_string" -t -A -F'|' -c "
    SELECT 
      COUNT(*)::bigint as total_tables,
      COUNT(*) FILTER (WHERE sr.srsubstate = 'r') as ready_tables,
      COUNT(*) FILTER (WHERE sr.srsubstate = 's') as syncing_tables,
      COUNT(*) FILTER (WHERE sr.srsubstate = 'i') as initializing_tables,
      COUNT(*) FILTER (WHERE sr.srsubstate = 'd') as data_copy_tables
    FROM pg_subscription s
    JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
    WHERE s.subname = '$sub_name'
  " 2>&1)
  local exit_code=$?
  set -e
  if [ $exit_code -ne 0 ]; then
    echo "ERROR"
    return 0
  fi
  echo "$result"
}

# Function to format bytes
format_bytes() {
  local bytes=$1
  if [ "$bytes" -gt 1099511627776 ]; then
    local tb=$((bytes / 1099511627776))
    local gb=$(((bytes % 1099511627776) / 1073741824))
    echo "${tb}.${gb}TB"
  elif [ "$bytes" -gt 1073741824 ]; then
    local gb=$((bytes / 1073741824))
    local mb=$(((bytes % 1073741824) / 1048576))
    echo "${gb}.${mb}GB"
  elif [ "$bytes" -gt 1048576 ]; then
    local mb=$((bytes / 1048576))
    local kb=$(((bytes % 1048576) / 1024))
    echo "${mb}.${kb}MB"
  elif [ "$bytes" -gt 1024 ]; then
    local kb=$((bytes / 1024))
    echo "${kb}KB"
  else
    echo "${bytes}B"
  fi
}

# Function to format time
format_time() {
  local seconds=$1
  if [ "$seconds" -gt 86400 ]; then
    local days=$((seconds / 86400))
    local hours=$(((seconds % 86400) / 3600))
    echo "${days}d ${hours}h"
  elif [ "$seconds" -gt 3600 ]; then
    local hours=$((seconds / 3600))
    local mins=$(((seconds % 3600) / 60))
    echo "${hours}h ${mins}m"
  elif [ "$seconds" -gt 60 ]; then
    local mins=$((seconds / 60))
    echo "${mins}m ${seconds}s"
  else
    echo "${seconds}s"
  fi
}

# Print header
printf "%-19s | %12s | %15s | %15s | %10s | %8s | %15s\n" \
  "Timestamp" "WAL Lag" "Slot Lag" "Time Lag" "Worker" "Tables" "Sync Status"
echo "------------------------------------------------------------------------------------------------------------------------"

PREVIOUS_SLOT_LAG=0
ITERATION=0

while true; do
  ITERATION=$((ITERATION + 1))
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  
  # Get metrics
  SUB_METRICS=$(get_subscription_metrics "$TARGET_CONNECTION_STRING" "$SUBSCRIPTION_NAME")
  SLOT_METRICS=$(get_slot_lag "$SOURCE_CONNECTION_STRING" "$SUBSCRIPTION_NAME")
  TABLE_STATUS=$(get_table_sync_status "$TARGET_CONNECTION_STRING" "$SUBSCRIPTION_NAME")
  
  # Check for errors
  if [ "$SUB_METRICS" = "ERROR" ] || [ "$SLOT_METRICS" = "ERROR" ] || [ "$TABLE_STATUS" = "ERROR" ]; then
    echo "[$TIMESTAMP] Error: Failed to query metrics. Retrying next iteration..."
    sleep "$INTERVAL"
    continue
  fi
  
  # Parse subscription metrics
  IFS='|' read -r worker_pid received_lsn latest_end_lsn lag_seconds latest_end_time last_msg_send_time last_msg_receipt_time <<< "$SUB_METRICS"
  
  # Parse slot metrics
  IFS='|' read -r slot_active slot_lag_bytes confirmed_lag_bytes restart_lsn confirmed_flush_lsn <<< "$SLOT_METRICS"
  
  # Parse table status
  IFS='|' read -r total_tables ready_tables syncing_tables initializing_tables data_copy_tables <<< "$TABLE_STATUS"
  
  # Calculate WAL lag (difference between current WAL and latest_end_lsn)
  # We'll use slot lag as proxy for WAL lag
  WAL_LAG_STR=$(format_bytes "$slot_lag_bytes")
  SLOT_LAG_STR=$(format_bytes "$confirmed_lag_bytes")
  TIME_LAG_STR=$(format_time "$lag_seconds")
  
  # Worker status
  if [ "$worker_pid" != "NULL" ] && [ -n "$worker_pid" ]; then
    WORKER_STATUS="Running"
  else
    WORKER_STATUS="Stopped"
  fi
  
  # Sync status
  if [ "$ready_tables" -eq "$total_tables" ] && [ "$total_tables" -gt 0 ]; then
    SYNC_STATUS="All Ready"
  elif [ "$syncing_tables" -gt 0 ]; then
    SYNC_STATUS="${syncing_tables} Syncing"
  elif [ "$initializing_tables" -gt 0 ]; then
    SYNC_STATUS="${initializing_tables} Init"
  elif [ "$data_copy_tables" -gt 0 ]; then
    SYNC_STATUS="${data_copy_tables} Copy"
  else
    SYNC_STATUS="Unknown"
  fi
  
  # Print row
  printf "%-19s | %12s | %15s | %15s | %8s | %8s | %15s\n" \
    "$TIMESTAMP" \
    "$WAL_LAG_STR" \
    "$SLOT_LAG_STR" \
    "$TIME_LAG_STR" \
    "$WORKER_STATUS" \
    "$total_tables" \
    "$SYNC_STATUS"
  
  # Show progress indicator
  if [ "$slot_lag_bytes" -gt 0 ] && [ "$PREVIOUS_SLOT_LAG" -gt 0 ]; then
    LAG_CHANGE=$((PREVIOUS_SLOT_LAG - slot_lag_bytes))
    if [ "$LAG_CHANGE" -gt 0 ]; then
      LAG_CHANGE_STR=$(format_bytes "$LAG_CHANGE")
      echo "  → Catching up: $LAG_CHANGE_STR reduced in last interval"
    elif [ "$LAG_CHANGE" -lt 0 ]; then
      LAG_INCREASE=$((slot_lag_bytes - PREVIOUS_SLOT_LAG))
      LAG_INCREASE_STR=$(format_bytes "$LAG_INCREASE")
      echo "  → Warning: Lag increased by $LAG_INCREASE_STR (replication may be lagging)"
    fi
  fi
  
  PREVIOUS_SLOT_LAG=$slot_lag_bytes
  
  sleep "$INTERVAL"
done

