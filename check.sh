#!/bin/bash
# monitor-catchup.sh

while true; do
  psql $SOURCE_DATABASE_URL << 'EOF'
\x
SELECT 
    NOW() as timestamp,
    catalog_xmin,
    restart_lsn,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as lag,
    pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as lag_bytes
FROM pg_replication_slots
WHERE slot_name = 'backup_slot_1763723611911';
EOF
  echo "---"
  sleep 60
done
