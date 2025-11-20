#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/subscription-diagnostics.sh <subscription_name> <slot_name> [publication_name] [backup_lsn]

Requires SOURCE_DATABASE_URL and TARGET_DATABASE_URL.
EOF
  exit 1
}

if [[ $# -lt 2 || $# -gt 4 ]]; then
  usage
fi

SUB_NAME="$1"
SLOT_NAME="$2"
PUB_NAME="${3:-}"
BACKUP_LSN="${4:-}"

if [[ -z "${SOURCE_DATABASE_URL:-}" || -z "${TARGET_DATABASE_URL:-}" ]]; then
  echo "ERROR: SOURCE_DATABASE_URL and TARGET_DATABASE_URL must be set." >&2
  exit 2
fi

run() {
  local label="$1"
  local sql="$2"
  local db="$3"
  echo "---- ${label} ----"
  psql "$db" -c "$sql"
  echo
}

TARGET_SUB_SQL="
SELECT 
  s.subname,
  s.subenabled,
  s.subslotname AS slot_name,
  s.subpublications AS publications,
  s.subconninfo AS conninfo,
  ss.pid,
  ss.relid::regclass AS current_table,
  ss.received_lsn,
  ss.last_msg_send_time,
  ss.last_msg_receipt_time,
  ss.latest_end_lsn,
  ss.latest_end_time
FROM pg_subscription s
LEFT JOIN pg_stat_subscription ss ON s.subname = ss.subname
WHERE s.subname = '${SUB_NAME}';
"

TARGET_REL_SQL="
SELECT 
  r.srrelid::regclass AS table_name,
  r.srsubstate,
  r.srsublsn
FROM pg_subscription_rel r
JOIN pg_subscription s ON s.oid = r.srsubid
WHERE s.subname = '${SUB_NAME}'
ORDER BY table_name;
"

SOURCE_SLOT_SQL="
SELECT 
  slot_name,
  plugin,
  database,
  active,
  restart_lsn,
  confirmed_flush_lsn,
  wal_status,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_from_restart
FROM pg_replication_slots
WHERE slot_name = '${SLOT_NAME}';
"

SOURCE_REPL_SQL="
SELECT 
  application_name,
  client_addr,
  state,
  sync_state,
  sent_lsn,
  write_lsn,
  flush_lsn,
  replay_lsn,
  pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn) AS lag_bytes,
  write_lag,
  flush_lag,
  replay_lag
FROM pg_stat_replication
WHERE application_name = '${SUB_NAME}';
"

if [[ -n "$PUB_NAME" ]]; then
  SOURCE_PUB_SQL="
    SELECT schemaname, tablename
    FROM pg_publication_tables
    WHERE pubname = '${PUB_NAME}'
    ORDER BY schemaname, tablename;
  "
else
  SOURCE_PUB_SQL=""
fi

run "TARGET subscription + stats" "$TARGET_SUB_SQL" "$TARGET_DATABASE_URL"
run "TARGET per-table subscription state" "$TARGET_REL_SQL" "$TARGET_DATABASE_URL"
run "SOURCE replication slot" "$SOURCE_SLOT_SQL" "$SOURCE_DATABASE_URL"
run "SOURCE pg_stat_replication" "$SOURCE_REPL_SQL" "$SOURCE_DATABASE_URL"

if [[ -n "$SOURCE_PUB_SQL" ]]; then
  run "SOURCE publication tables (${PUB_NAME})" "$SOURCE_PUB_SQL" "$SOURCE_DATABASE_URL"
fi

if [[ -n "$BACKUP_LSN" ]]; then
  LSN_SQL="
    SELECT
      '${BACKUP_LSN}'::pg_lsn AS backup_lsn,
      confirmed_flush_lsn,
      pg_wal_lsn_diff(confirmed_flush_lsn, '${BACKUP_LSN}') AS bytes_since_backup,
      pg_size_pretty(pg_wal_lsn_diff(confirmed_flush_lsn, '${BACKUP_LSN}')) AS pretty_since_backup
    FROM pg_replication_slots
    WHERE slot_name = '${SLOT_NAME}';
  "
  run "Slot progress vs backup LSN" "$LSN_SQL" "$SOURCE_DATABASE_URL"
fi

