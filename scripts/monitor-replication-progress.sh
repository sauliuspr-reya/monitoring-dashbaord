#!/bin/bash

# Monitor replication progress by tracking row count differences over time
# Usage: ./scripts/monitor-replication-progress.sh [table_name] [interval_seconds] [--exact]
# Table name can be "orders" or "public.orders"
# Use --exact flag to always use exact counts (slower but more accurate)

set -euo pipefail

TABLE_NAME="${1:-orders}"
INTERVAL="${2:-30}"
USE_EXACT_COUNTS=false

# Check for --exact flag
if [ "${3:-}" = "--exact" ] || [ "${2:-}" = "--exact" ]; then
  USE_EXACT_COUNTS=true
  # If --exact was the second arg, interval defaults to 60
  if [ "${2:-}" = "--exact" ]; then
    INTERVAL=60
  fi
fi

# Parse table name (support both "table" and "schema.table" formats)
if [[ "$TABLE_NAME" == *.* ]]; then
  SCHEMA_NAME="${TABLE_NAME%.*}"
  TABLE_ONLY="${TABLE_NAME#*.}"
else
  SCHEMA_NAME="public"
  TABLE_ONLY="$TABLE_NAME"
fi
FULL_TABLE_NAME="${SCHEMA_NAME}.${TABLE_ONLY}"

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

echo "Monitoring replication progress for table: $FULL_TABLE_NAME"
echo "Update interval: ${INTERVAL} seconds"
if [ "$USE_EXACT_COUNTS" = "true" ]; then
  echo "Mode: Using exact counts (COUNT(*) - SLOW but accurate)"
  echo "      ⚠️  This will be very slow on large tables!"
else
  echo "Mode: Using estimates (n_live_tup/reltuples - FAST)"
  echo "      Estimates are accurate enough for monitoring replication progress"
  echo "      Use --exact flag only if you need exact counts (will be slow)"
fi
echo "Press Ctrl+C to stop"
echo ""

# Function to get row count (using exact count for accuracy)
get_row_count() {
  local conn_string="$1"
  local schema="$2"
  local table="$3"
  local result
  set +e  # Temporarily disable exit on error
  result=$(psql "$conn_string" -t -A -c "
    SELECT COUNT(*)::bigint
    FROM ${schema}.${table}
  " 2>&1)
  local exit_code=$?
  set -e  # Re-enable exit on error
  if [ $exit_code -ne 0 ]; then
    echo "ERROR"
    return 0  # Return 0 so script doesn't exit, but output "ERROR"
  fi
  local cleaned=$(echo "$result" | tr -d ' \n\r')
  if [ -z "$cleaned" ]; then
    echo "ERROR"
  else
    echo "$cleaned"
  fi
}

# Function to get estimated row count (faster) - matches working codebase query
get_estimated_row_count() {
  local conn_string="$1"
  local schema="$2"
  local table="$3"
  local result
  set +e  # Temporarily disable exit on error
  # Match the exact query from monitoring.service.ts that works correctly
  result=$(psql "$conn_string" -t -A -c "
    SELECT COALESCE(s.n_live_tup::bigint, c.reltuples::bigint, 0) as estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid AND s.schemaname = n.nspname
    WHERE c.relname = '$table' 
      AND n.nspname = '$schema'
      AND c.relkind = 'r'
  " 2>&1)
  local exit_code=$?
  set -e  # Re-enable exit on error
  if [ $exit_code -ne 0 ]; then
    echo "ERROR"
    return 0  # Return 0 so script doesn't exit, but output "ERROR"
  fi
  local cleaned=$(echo "$result" | tr -d ' \n\r')
  if [ -z "$cleaned" ]; then
    echo "ERROR"
  else
    echo "$cleaned"
  fi
}

# Function to get replication lag
get_replication_lag() {
  local conn_string="$1"
  local result
  set +e  # Temporarily disable exit on error
  result=$(psql "$conn_string" -t -A -c "
    SELECT 
      COALESCE(
        EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp()))::bigint,
        0
      )
  " 2>&1)
  local exit_code=$?
  set -e  # Re-enable exit on error
  if [ $exit_code -ne 0 ]; then
    echo "0"
    return 0
  fi
  local cleaned=$(echo "$result" | tr -d ' \n\r')
  echo "${cleaned:-0}"
}

# Function to get subscription status
get_subscription_status() {
  local conn_string="$1"
  psql "$conn_string" -t -c "
    SELECT 
      subname,
      subenabled,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - last_msg_send_time))::bigint, 0) as lag_seconds,
      COALESCE(last_msg_receipt_time, last_msg_send_time) as last_activity
    FROM pg_subscription s
    LEFT JOIN pg_stat_subscription ss ON s.oid = ss.subid
    WHERE subenabled = true
    LIMIT 1
  " 2>/dev/null || echo ""
}

# Initial snapshot - use estimates by default (much faster), only use exact if --exact flag is set
echo "Taking initial snapshot..."
if [ "$USE_EXACT_COUNTS" = "true" ]; then
  INITIAL_SOURCE=$(get_row_count "$SOURCE_CONNECTION_STRING" "$SCHEMA_NAME" "$TABLE_ONLY")
  if [ "$INITIAL_SOURCE" = "ERROR" ] || [ -z "$INITIAL_SOURCE" ]; then
    echo "Error: Failed to get source row count. Check connection and table name."
    exit 1
  fi
  INITIAL_TARGET=$(get_row_count "$TARGET_CONNECTION_STRING" "$SCHEMA_NAME" "$TABLE_ONLY")
  if [ "$INITIAL_TARGET" = "ERROR" ] || [ -z "$INITIAL_TARGET" ]; then
    echo "Error: Failed to get target row count. Check connection and table name."
    exit 1
  fi
else
  # Use estimates for initial snapshot (much faster)
  INITIAL_SOURCE=$(get_estimated_row_count "$SOURCE_CONNECTION_STRING" "$SCHEMA_NAME" "$TABLE_ONLY")
  if [ "$INITIAL_SOURCE" = "ERROR" ] || [ -z "$INITIAL_SOURCE" ]; then
    echo "Error: Failed to get source row count estimate. Check connection and table name."
    exit 1
  fi
  INITIAL_TARGET=$(get_estimated_row_count "$TARGET_CONNECTION_STRING" "$SCHEMA_NAME" "$TABLE_ONLY")
  if [ "$INITIAL_TARGET" = "ERROR" ] || [ -z "$INITIAL_TARGET" ]; then
    echo "Error: Failed to get target row count estimate. Check connection and table name."
    exit 1
  fi
fi

INITIAL_GAP=$((INITIAL_SOURCE - INITIAL_TARGET))

echo "Initial state:"
echo "  Source: $INITIAL_SOURCE rows"
echo "  Target: $INITIAL_TARGET rows"
echo "  Gap: $INITIAL_GAP rows"
echo ""

# Validate initial counts are reasonable
if [ "$INITIAL_SOURCE" -lt 0 ] || [ "$INITIAL_TARGET" -lt 0 ]; then
  echo "Warning: Invalid row counts detected. Please verify table name and connections."
fi

# Print header
printf "%-19s | %15s | %15s | %15s | %15s | %10s\n" \
  "Timestamp" "Source Rows" "Target Rows" "Gap" "Change" "Lag (s)"
echo "--------------------------------------------------------------------------------------------------------"

PREVIOUS_TARGET=$INITIAL_TARGET
ITERATION=0

while true; do
  ITERATION=$((ITERATION + 1))
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  
  # Get current counts - NEVER use COUNT(*) unless --exact flag is set (it's too slow)
  if [ "$USE_EXACT_COUNTS" = "true" ]; then
    # Only use exact counts if explicitly requested
    CURRENT_SOURCE=$(get_row_count "$SOURCE_CONNECTION_STRING" "$SCHEMA_NAME" "$TABLE_ONLY")
    CURRENT_TARGET=$(get_row_count "$TARGET_CONNECTION_STRING" "$SCHEMA_NAME" "$TABLE_ONLY")
  else
    # Always use estimates (fast and accurate enough for monitoring)
    CURRENT_SOURCE=$(get_estimated_row_count "$SOURCE_CONNECTION_STRING" "$SCHEMA_NAME" "$TABLE_ONLY")
    CURRENT_TARGET=$(get_estimated_row_count "$TARGET_CONNECTION_STRING" "$SCHEMA_NAME" "$TABLE_ONLY")
  fi
  
  # Check for errors
  if [ "$CURRENT_SOURCE" = "ERROR" ] || [ "$CURRENT_TARGET" = "ERROR" ]; then
    echo "[$TIMESTAMP] Error: Failed to query row counts. Retrying next iteration..."
    sleep "$INTERVAL"
    continue
  fi
  
  CURRENT_GAP=$((CURRENT_SOURCE - CURRENT_TARGET))
  TARGET_CHANGE=$((CURRENT_TARGET - PREVIOUS_TARGET))
  
  # Get replication lag from target
  REPLICATION_LAG=$(get_replication_lag "$TARGET_CONNECTION_STRING")
  
  # Format change with sign
  if [ $TARGET_CHANGE -gt 0 ]; then
    CHANGE_STR="+$TARGET_CHANGE"
  elif [ $TARGET_CHANGE -lt 0 ]; then
    CHANGE_STR="$TARGET_CHANGE"
  else
    CHANGE_STR="0"
  fi
  
  # Print row
  printf "%-19s | %15s | %15s | %15s | %15s | %10s\n" \
    "$TIMESTAMP" \
    "$CURRENT_SOURCE" \
    "$CURRENT_TARGET" \
    "$CURRENT_GAP" \
    "$CHANGE_STR" \
    "$REPLICATION_LAG"
  
  # Show progress indicator
  if [ $INITIAL_GAP -gt 0 ]; then
    if [ $CURRENT_GAP -lt $INITIAL_GAP ]; then
      PROGRESS=$((100 * (INITIAL_GAP - CURRENT_GAP) / INITIAL_GAP))
      if [ $PROGRESS -le 100 ]; then
        echo "  → Progress: $PROGRESS% caught up ($((INITIAL_GAP - CURRENT_GAP)) of $INITIAL_GAP rows)"
      fi
    elif [ $CURRENT_GAP -gt $INITIAL_GAP ]; then
      INCREASE=$((CURRENT_GAP - INITIAL_GAP))
      echo "  → Warning: Gap increased by $INCREASE rows (replication may be lagging)"
    fi
  fi
  
  PREVIOUS_TARGET=$CURRENT_TARGET
  
  sleep "$INTERVAL"
done

