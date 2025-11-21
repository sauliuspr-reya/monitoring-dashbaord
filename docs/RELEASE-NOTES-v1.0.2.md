# Release Notes - v1.0.2

**Release Date**: November 21, 2025  
**Type**: Critical Bug Fix

## 🚨 Critical Bug Fix

### Fixed: Growing Replication Gap When Dropping/Recreating Subscriptions

**Issue ID**: `99ADB7E0`

**Symptom**: When dropping and recreating a subscription multiple times, the replication gap/lag grows larger each time, eventually causing significant delays in data replication.

**Root Cause**:

When deleting a subscription via the API/UI, the default behavior was:
- ✅ Drop subscription on TARGET database
- ❌ Keep replication slot on SOURCE database (`dropSlot = false` by default)

This caused **orphaned replication slots** on the source database:

1. **First Drop**: 
   - Subscription deleted on target
   - Replication slot `orders_slot_1` stays on source, continues accumulating WAL
   
2. **Recreate**:
   - New subscription created
   - Tries to use slot `orders_slot_1` (now way behind with accumulated WAL)
   - Must replay all accumulated WAL → large gap
   
3. **Second Drop**:
   - Another orphaned slot accumulates WAL
   
4. **Each Cycle**:
   - Gap grows exponentially
   - More WAL to replay
   - Slower catchup times

**Impact**:

- Replication lag growing from MB to GB over multiple drop/recreate cycles
- Slower replication catchup after recreating subscriptions
- Wasted disk space on source database from accumulated WAL
- Increased risk of running out of replication slots
- Performance degradation on source database

**The Fix**:

Changed default behavior in `/pages/api/subscriptions/[id]/delete.ts`:

```typescript
// Before (v1.0.1)
const { 
  dropSubscription = true,
  dropPublication = false,
  dropSlot = false,  // ❌ Kept orphaned slots!
} = req.body || {};

// After (v1.0.2)
const { 
  dropSubscription = true,
  dropPublication = false,
  dropSlot = true,  // ✅ Clean up slots by default
} = req.body || {};
```

**Additional Improvements**:

1. **Use CASCADE on DROP SUBSCRIPTION**:
   ```sql
   DROP SUBSCRIPTION IF EXISTS "subscription_name" CASCADE;
   ```
   This should automatically drop the slot on the source database.

2. **Verify Slot Deletion**:
   - After dropping subscription, check if slot still exists on source
   - If exists, drop it manually
   - If already gone, log success (CASCADE worked)

3. **Better Logging**:
   - Log WAL lag before dropping slot
   - Warn if slot has > 1GB lag
   - Warn if slot is still active
   - Log success/failure of slot cleanup

4. **Error Handling**:
   - Treat "slot does not exist" as success (already cleaned up)
   - Better error messages for troubleshooting

## 📊 Before vs After

### Before (v1.0.1)

```
Drop Subscription #1
├─ Subscription dropped ✅
├─ Slot 'orders_slot' orphaned ❌
└─ Accumulating WAL: 500MB

Create Subscription #1 (again)
├─ Using slot 'orders_slot'
├─ Must replay 500MB WAL
└─ Lag: 500MB

Drop Subscription #2
├─ Subscription dropped ✅
├─ Slot 'orders_slot' orphaned again ❌
└─ Accumulating WAL: 500MB + 1GB = 1.5GB

Create Subscription #2 (again)
├─ Using slot 'orders_slot'
├─ Must replay 1.5GB WAL
└─ Lag: 1.5GB (3x worse!)
```

### After (v1.0.2)

```
Drop Subscription
├─ Subscription dropped ✅
├─ Slot dropped automatically ✅
└─ No WAL accumulation ✅

Create Subscription (again)
├─ Creates fresh slot
├─ No accumulated WAL
└─ Lag: minimal (normal)
```

## 🔧 Manual Cleanup (If Needed)

If you have **existing orphaned slots** from v1.0.1, clean them up manually:

### Step 1: Check for Orphaned Slots (on SOURCE)

```sql
-- Find inactive slots with high WAL lag
SELECT 
  slot_name,
  active,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as wal_lag,
  pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as wal_lag_bytes
FROM pg_replication_slots
WHERE NOT active
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;
```

### Step 2: Verify No Matching Subscription (on TARGET)

```sql
-- Make sure no subscription is using this slot
SELECT subname, subslotname 
FROM pg_subscription 
WHERE subslotname = 'orders_slot';
```

### Step 3: Drop Orphaned Slot (on SOURCE)

```sql
-- Only if inactive and no subscription uses it!
SELECT pg_drop_replication_slot('orders_slot');
```

### Step 4: Verify Cleanup

```sql
-- Check slot is gone
SELECT COUNT(*) FROM pg_replication_slots WHERE slot_name = 'orders_slot';
-- Should return 0
```

## 🧪 Testing

To verify the fix works:

1. Create a test subscription
2. Delete it via the UI
3. Check source database:
   ```sql
   SELECT * FROM pg_replication_slots WHERE slot_name = 'test_slot';
   ```
4. Verify slot is gone (no rows returned)

## 📝 Files Changed

- `/pages/api/subscriptions/[id]/delete.ts`
  - Changed `dropSlot` default from `false` → `true` (line 17)
  - Added `CASCADE` to `DROP SUBSCRIPTION` (line 55)
  - Improved slot deletion verification (lines 77-119)
  - Better logging and error handling

## ⚠️ Breaking Changes

**None**. This is a bug fix that changes default behavior to be more correct.

If you explicitly want to keep slots (rare), you can still pass `{ dropSlot: false }` in the DELETE request body.

## 🔄 Migration

**Action Required**: Clean up existing orphaned slots manually (see "Manual Cleanup" section above).

After upgrading to v1.0.2:
- Future drops will automatically clean up slots ✅
- Existing orphaned slots need manual cleanup ⚠️

## 📦 Version Info

- **Previous**: v1.0.1
- **Current**: v1.0.2
- **Type**: Critical Bug Fix
- **Lines Changed**: ~60

---

**Reported By**: Saulius (Issue: `99ADB7E0`)  
**Fixed By**: Cascade AI  
**Severity**: Critical (Data/Performance)
