# Replication Slot Reference Guide

## Quick Reference: `pg_replication_slots` Columns

This guide explains what you see in the replication slot details panel.

---

## Column Explanations

### 🆔 Identification

| Column | Example | Meaning |
|--------|---------|---------|
| **slot_name** | `backup_slot_1763723611911` | Unique identifier for this slot |
| **plugin** | `pgoutput` | Output plugin for logical decoding (standard PostgreSQL plugin) |
| **slot_type** | `logical` | Type: `logical` (row-level) vs `physical` (block-level for read replicas) |
| **database** | `reya` | Database this slot belongs to |
| **datoid** | `16401` | Internal database object ID |
| **temporary** | `false` | If `true`, drops when session ends. `false` = persistent |

---

### 🔴 Activity Status (Critical for Determining if Orphaned)

| Column | Value | Meaning | Safety Check |
|--------|-------|---------|--------------|
| **active** | `true` | Subscription is currently using this slot | ❌ **DO NOT DROP** |
| **active** | `false` | No subscription using this slot | ✅ Potentially safe to drop |
| **active_pid** | `12345` | Process ID of the backend using this slot | ❌ **In use** |
| **active_pid** | `null` | No process connected | ✅ Not in use |

**Safe to drop if:** `active = false` AND `active_pid = null` AND slot is old/orphaned

---

### 📍 LSN (Log Sequence Number) - WAL Positions

**LSN = Position in PostgreSQL's Write-Ahead Log (like a bookmark in the transaction log)**

| Column | Example | Meaning | Impact |
|--------|---------|---------|--------|
| **restart_lsn** | `14/AF33AFA0` | Position where replication must restart from | PostgreSQL keeps all WAL from this point forward |
| **confirmed_flush_lsn** | `14/AF33D6E8` | Latest WAL position confirmed by subscriber | Slightly ahead of `restart_lsn` |

**LSN Format**: `14/AF33AFA0`
- `14` = WAL segment ID
- `/` = separator
- `AF33AFA0` = Byte position in segment (hex)

**WAL Lag Calculation**:
```sql
pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
```
This shows how much WAL is being held for this slot.

---

### 🔄 Transaction Tracking

| Column | Example | Meaning |
|--------|---------|---------|
| **xmin** | `null` | Oldest transaction ID this slot needs (rarely used for logical slots) |
| **catalog_xmin** | `1088131497` | Oldest catalog transaction this slot needs. PostgreSQL keeps catalog changes from this point. |

---

### 💾 WAL Management

| Column | Value | Meaning | What It Means for You |
|--------|-------|---------|------------------------|
| **wal_status** | `reserved` | ✅ WAL files are reserved for this slot | Good if active, bad if orphaned (wasting space) |
| **wal_status** | `extended` | 🟡 WAL files extending beyond normal retention | Slot is falling behind |
| **wal_status** | `unreserved` | ⚠️ WAL not reserved, slot at risk | May lose data if WAL is recycled |
| **safe_wal_size** | `null` or number | Bytes until `max_slot_wal_keep_size` limit | Empty = no limit configured |
| **two_phase** | `false` | Support for two-phase commit transactions | Standard = single-phase |

---

## Visual Guide: Understanding Slot States

### 🟢 **HEALTHY ACTIVE SLOT**
```
active = true
active_pid = 12345
wal_status = reserved
slot_lag < 1GB
```
✅ **Status**: Normal operation  
✅ **Action**: Keep monitoring

---

### 🟡 **INACTIVE SLOT (Waiting for Subscription)**
```
active = false
active_pid = null
wal_status = reserved
Created < 24 hours ago
```
✅ **Status**: Normal - backup slot before subscription created  
✅ **Action**: Create subscription soon to avoid WAL accumulation

---

### 🔴 **ORPHANED SLOT (Problem!)**
```
active = false
active_pid = null
wal_status = reserved
Created > 7 days ago
WAL lag > 5GB
```
❌ **Status**: Orphaned - wasting disk space  
❌ **Action**: Investigate and drop if no longer needed

---

## Severity Levels: WAL Lag

| Lag Size | Severity | Icon | Action |
|----------|----------|------|--------|
| < 100MB | OK | 🟢 | Normal |
| 100MB - 1GB | Info | 🔵 | Monitor |
| 1GB - 5GB | Caution | 🟡 | Check if slot is needed |
| 5GB - 10GB | Warning | 🟠 | Likely orphaned - consider dropping |
| > 10GB | Critical | 🔴 | Orphaned - should drop if unused |

---

## Common Scenarios

### Scenario 1: Recent Backup Slot
```sql
slot_name: backup_slot_1763723611911
active: false
created: 2 hours ago
wal_status: reserved
wal_lag: 500MB
```
**Verdict**: ✅ **Normal** - Waiting for subscription to be created  
**Action**: Create subscription within 24 hours

---

### Scenario 2: Active Subscription
```sql
slot_name: orders_subscription_slot
active: true
active_pid: 54321
wal_status: reserved
wal_lag: 50MB
```
**Verdict**: ✅ **Healthy** - Subscription actively replicating  
**Action**: None - keep monitoring

---

### Scenario 3: Orphaned Slot
```sql
slot_name: backup_slot_1763454198
active: false
active_pid: null
created: 4 days ago
wal_status: reserved
wal_lag: 15GB
```
**Verdict**: ❌ **Orphaned** - Wasting 15GB of disk space  
**Action**: Verify no subscription needs it, then drop:
```sql
SELECT pg_drop_replication_slot('backup_slot_1763454198');
```

---

## Safety Checklist Before Dropping a Slot

Before running `pg_drop_replication_slot()`:

✅ Confirm `active = false`  
✅ Confirm `active_pid = null`  
✅ Verify no subscription on TARGET database uses this slot:
```sql
-- On TARGET database
SELECT * FROM pg_subscription WHERE subslotname = 'your_slot_name';
```
✅ Confirm slot is old (created > 7 days ago) OR backup is no longer needed  
✅ Check WAL lag is high (> 1GB) - indicates long-term abandonment  
✅ Verify it's a `logical` slot (not affecting RDS read replicas)

❌ **DO NOT DROP** if:
- Slot is active
- Recent backup slot you plan to use
- Unsure if subscription needs it

---

## Quick Commands

### Check All Logical Slots
```sql
SELECT 
    slot_name,
    active,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as wal_lag,
    wal_status
FROM pg_replication_slots
WHERE slot_type = 'logical'
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;
```

### Find Orphaned Slots
```sql
SELECT slot_name, active, 
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as lag
FROM pg_replication_slots
WHERE slot_type = 'logical' 
  AND active = false
  AND pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) > 1073741824  -- >1GB
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;
```

### Drop Orphaned Slot (after verification!)
```sql
-- CAREFUL! Only drop after confirming it's truly orphaned
SELECT pg_drop_replication_slot('slot_name_here');
```

---

## FAQ

**Q: Why is my slot inactive but still reserving WAL?**  
A: Normal for backup slots before subscription is created. If it stays inactive for > 24 hours, it's likely orphaned.

**Q: What's the difference between restart_lsn and confirmed_flush_lsn?**  
A: `restart_lsn` = where replication must restart from. `confirmed_flush_lsn` = latest position subscriber confirmed receiving. Usually very close.

**Q: Will dropping a logical slot affect my RDS read replicas?**  
A: **No!** Read replicas use physical replication (different system). Logical slots only affect logical subscriptions.

**Q: How much WAL lag is too much?**  
A: > 1GB for inactive slots = likely orphaned. > 10GB = definitely orphaned and wasting significant space.

**Q: Can I safely drop a slot with wal_status = 'reserved'?**  
A: Yes, IF it's inactive, orphaned, and no subscription uses it. The 'reserved' status just means WAL is being held.

---

## Related Documentation

- [PostgreSQL Logical Replication](https://www.postgresql.org/docs/current/logical-replication.html)
- [Replication Slots](https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS)
- [pg_replication_slots View](https://www.postgresql.org/docs/current/view-pg-replication-slots.html)
