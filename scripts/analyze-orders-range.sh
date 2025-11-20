#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: scripts/analyze-orders-range.sh <start_iso> <end_iso> <backup_lsn> [slot_name]" >&2
  echo "Example: scripts/analyze-orders-range.sh 2025-11-20T09:40:00Z 2025-11-20T09:50:00Z 14/15684C8 orders_subscription_slot" >&2
  exit 1
fi

START_ISO="$1"
END_ISO="$2"
BACKUP_LSN="$3"
SLOT_NAME="${4:-orders_subscription_slot}"
SCHEMA_NAME="public"
TABLE_NAME="orders"

if [[ -z "${SOURCE_DATABASE_URL:-}" || -z "${TARGET_DATABASE_URL:-}" ]]; then
  echo "ERROR: SOURCE_DATABASE_URL and TARGET_DATABASE_URL must be set." >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to parse timestamps." >&2
  exit 3
fi

to_epoch() {
  python3 - <<'PY' "$1"
import sys
from datetime import datetime, timezone
iso = sys.argv[1]
dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
print(int(dt.astimezone(timezone.utc).timestamp()))
PY
}

START_EPOCH=$(to_epoch "$START_ISO")
END_EPOCH=$(to_epoch "$END_ISO")

echo "Analyzing ${SCHEMA_NAME}.${TABLE_NAME} between:"
echo "  block_timestamp: ${START_EPOCH} (${START_ISO}) -> ${END_EPOCH} (${END_ISO})"
echo "  created_at: ${START_ISO} -> ${END_ISO}"
echo

block_sql="
SELECT
  COUNT(*) AS rows,
  MIN(event_sequence_number) AS min_seq,
  MAX(event_sequence_number) AS max_seq,
  MIN(block_timestamp) AS min_block_ts,
  MAX(block_timestamp) AS max_block_ts
FROM ${SCHEMA_NAME}.${TABLE_NAME}
WHERE block_timestamp BETWEEN ${START_EPOCH} AND ${END_EPOCH};
"

created_sql="
SELECT
  COUNT(*) AS rows,
  MIN(event_sequence_number) AS min_seq,
  MAX(event_sequence_number) AS max_seq,
  MIN(created_at) AS min_created_at,
  MAX(created_at) AS max_created_at
FROM ${SCHEMA_NAME}.${TABLE_NAME}
WHERE created_at BETWEEN '${START_ISO}'::timestamptz AND '${END_ISO}'::timestamptz;
"

lsn_sql="
SELECT
  slot_name,
  restart_lsn,
  confirmed_flush_lsn,
  pg_wal_lsn_diff(confirmed_flush_lsn, '${BACKUP_LSN}') AS bytes_since_backup,
  pg_size_pretty(pg_wal_lsn_diff(confirmed_flush_lsn, '${BACKUP_LSN}')) AS pretty_since_backup,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_to_restart
FROM pg_replication_slots
WHERE slot_name = '${SLOT_NAME}';
"

run_query() {
  local label="$1"
  local sql="$2"
  local db_url="$3"

  echo "${label}"
  psql "$db_url" -c "$sql"
  echo
}

run_query "SOURCE block_timestamp window:" "$block_sql" "$SOURCE_DATABASE_URL"
run_query "TARGET block_timestamp window:" "$block_sql" "$TARGET_DATABASE_URL"

run_query "SOURCE created_at window:" "$created_sql" "$SOURCE_DATABASE_URL"
run_query "TARGET created_at window:" "$created_sql" "$TARGET_DATABASE_URL"

echo "Replication slot '${SLOT_NAME}' vs backup LSN ${BACKUP_LSN}:"
psql "$SOURCE_DATABASE_URL" -c "$lsn_sql"

