# Check Subscription Status

## Quick Command

### On Source Database (Publisher)
```sql
-- Check all subscriptions and their status
SELECT
  subname AS subscription_name,
  pid,
  status,
  received_lsn,
  latest_end_lsn,
  latest_end_time,
  sync_state
FROM pg_stat_subscription
ORDER BY subname;
```

### On Target Database (Subscriber)
```sql
-- Check subscription status
SELECT
  subname,
  subenabled,
  subpublications,
  subslotname,
  subconninfo
FROM pg_subscription
ORDER BY subname;

-- Check detailed subscription status with worker info
SELECT
  s.subname,
  s.subenabled,
  s.subpublications,
  sr.srsubstate,
  sr.srrelid::regclass AS table_name,
  sr.srsublsn,
  sr.srsubstate AS sync_state
FROM pg_subscription s
LEFT JOIN pg_subscription_rel sr ON sr.srsubid = s.oid
ORDER BY s.subname, sr.srrelid;
```

### Check Replication Lag
```sql
-- On source database - check replication lag
SELECT
  application_name,
  client_addr,
  state,
  sync_state,
  pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS sent_lag_bytes,
  pg_wal_lsn_diff(sent_lsn, write_lsn) AS write_lag_bytes,
  pg_wal_lsn_diff(write_lsn, flush_lsn) AS flush_lag_bytes,
  pg_wal_lsn_diff(flush_lsn, replay_lsn) AS replay_lag_bytes,
  pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS total_lag_bytes
FROM pg_stat_replication
WHERE application_name LIKE '%subscription%'
ORDER BY total_lag_bytes DESC;
```

## Using psql Command Line

```bash
# Check subscription on target database
psql -h TARGET_HOST -p 5432 -U postgres -d TARGET_DB -c "
  SELECT subname, subenabled, subpublications 
  FROM pg_subscription;
"

# Check subscription worker status
psql -h TARGET_HOST -p 5432 -U postgres -d TARGET_DB -c "
  SELECT * FROM pg_stat_subscription;
"
```

## Common Status Values

- **`r` (ready)**: Table is fully synced and replicating
- **`s` (synchronizing)**: Table is being synchronized
- **`i` (initializing)**: Table is in initial copy phase
- **`d` (data copy)**: Table is copying initial data

