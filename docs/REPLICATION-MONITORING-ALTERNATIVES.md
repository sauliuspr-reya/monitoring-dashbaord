# Replication Monitoring Alternatives to COUNT(*)

## Problem with COUNT(*)

`COUNT(*)` queries are **extremely expensive** on large tables:
- **30+ seconds** for 31M row tables
- **Very high CPU usage** (full table scan)
- **Locks table** during count
- **Kills database performance**

## Better Alternatives

### 1. WAL Lag Monitoring ⭐ **BEST CHOICE**

Monitor how far behind the subscription is in WAL (Write-Ahead Log) bytes:

```bash
./scripts/monitor-replication-lag.sh [subscription_name] [interval]
```

**What it shows:**
- **WAL Lag**: How many bytes of WAL are waiting to be consumed
- **Slot Lag**: How far behind the replication slot is
- **Time Lag**: How many seconds behind (based on last transaction time)
- **Worker Status**: Whether replication worker is running
- **Table Sync Status**: How many tables are ready/syncing/initializing

**Advantages:**
- ✅ **Instant** (milliseconds, not seconds)
- ✅ **No CPU impact** (reads from system catalogs)
- ✅ **Accurate** (shows real replication progress)
- ✅ **No table locks**

**Example output:**
```
Timestamp           |     WAL Lag |      Slot Lag |      Time Lag |   Worker |   Tables |    Sync Status
------------------------------------------------------------------------------------------------------------------------
2025-11-16 18:30:00 |       2.5GB |        2.3GB |          5m |  Running |      141 |    135 Ready
  → Catching up: 500MB reduced in last interval
```

### 2. Subscription Status Monitoring

Check subscription worker status and last activity:

```bash
./scripts/check-replication-lag.sh [table_name]
```

**What it shows:**
- Subscription worker PID and status
- Last message receipt time
- Replication slot lag
- Table sync states (initializing/data copy/syncing/ready)

### 3. Estimated Row Counts (When Needed)

If you really need row counts, use estimates:

```sql
-- Fast estimate (updated by autovacuum)
SELECT n_live_tup 
FROM pg_stat_user_tables 
WHERE schemaname = 'public' AND relname = 'orders';
```

**Performance:**
- ⚡ **~1ms** (vs 30+ seconds for COUNT(*))
- ✅ Accurate enough for monitoring (within 1-2% typically)
- ✅ No table locks

### 4. Table Sync State Monitoring

Monitor which tables are still syncing:

```sql
SELECT 
  c.relname as table_name,
  CASE sr.srsubstate
    WHEN 'i' THEN 'Initializing'
    WHEN 'd' THEN 'Data copy done'
    WHEN 's' THEN 'Synchronizing'
    WHEN 'r' THEN 'Ready'
  END as state
FROM pg_subscription s
JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
JOIN pg_class c ON sr.srrelid = c.oid
WHERE s.subname = 'your_subscription'
ORDER BY sr.srsubstate, c.relname;
```

## Recommended Approach

**For ongoing monitoring:**
1. Use `monitor-replication-lag.sh` - shows WAL lag and progress
2. Use `check-replication-lag.sh` - detailed status check
3. Use dashboard UI - shows estimates and sync status

**Only use COUNT(*) when:**
- You absolutely need exact counts
- Table is small (< 100K rows)
- You can accept 30+ second delays
- You're okay with high CPU usage

## Understanding the Metrics

### WAL Lag
- **What it is**: Bytes of WAL waiting to be consumed by subscription
- **Good**: < 1GB (subscription is keeping up)
- **Warning**: 1-10GB (subscription is lagging)
- **Critical**: > 10GB (subscription is struggling)

### Time Lag
- **What it is**: Seconds since last transaction was applied
- **Good**: < 10 seconds (near real-time)
- **Warning**: 10-60 seconds (some lag)
- **Critical**: > 60 seconds (significant lag)

### Slot Lag
- **What it is**: How far behind the replication slot is on source
- **Good**: < 1GB
- **Warning**: 1-10GB
- **Critical**: > 10GB (WAL may be accumulating)

### Table Sync States
- **'r' (Ready)**: Table is fully synced
- **'s' (Synchronizing)**: Table is catching up
- **'d' (Data copy done)**: Initial copy complete, now syncing
- **'i' (Initializing)**: Table is being set up

## Performance Comparison

| Method | Speed | CPU Impact | Accuracy | Use Case |
|--------|-------|------------|----------|----------|
| WAL Lag | ⚡⚡⚡⚡⚡ ~1ms | None | Perfect | **Recommended** |
| Slot Lag | ⚡⚡⚡⚡⚡ ~1ms | None | Perfect | **Recommended** |
| Time Lag | ⚡⚡⚡⚡⚡ ~1ms | None | Perfect | **Recommended** |
| Estimates | ⚡⚡⚡⚡⚡ ~1ms | None | ~99% | When row counts needed |
| COUNT(*) | ⚡ 30+ sec | Very High | 100% | **Avoid** |

## Quick Start

**Monitor replication progress (recommended):**
```bash
./scripts/monitor-replication-lag.sh your_subscription 30
```

**Check detailed status:**
```bash
./scripts/check-replication-lag.sh orders
```

**In dashboard:**
- Go to `/subscriptions/[id]` 
- View "Replication Status" tab
- Shows estimates (no COUNT(*) queries)

## Summary

**Don't use COUNT(*) for monitoring!** Instead:
1. ✅ Use WAL lag monitoring (`monitor-replication-lag.sh`)
2. ✅ Use subscription status checks
3. ✅ Use estimated row counts when needed
4. ✅ Monitor table sync states

These methods are **instant**, **CPU-friendly**, and **accurate enough** for monitoring replication progress.


