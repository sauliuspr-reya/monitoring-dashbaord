# Subscription Operations Review: Create, Edit, Delete

## Current Implementation Status

### ✅ CREATE Subscription (`/api/subscriptions/create.ts`)

**What it does:**
1. Creates publication on **source** database (if doesn't exist)
2. Creates subscription on **target** database with `copy_data` parameter
3. Handles existing slot (uses `create_slot = false` if slot exists)
4. Saves to monitoring database with `data_copy` flag

**Issues Found:**
1. ⚠️ If subscription already exists, it silently skips creation (line 148)
   - Should either error or provide option to update
2. ⚠️ If publication exists but tables are different, doesn't update it
3. ✅ Correctly handles `dataCopy` parameter for both true/false
4. ✅ Correctly checks for existing slot and uses `create_slot = false` if exists

**Recommendations:**
- Add check: if subscription exists, return error or offer to update
- Add option to refresh publication tables if they differ

### ✅ DELETE Subscription (`/api/subscriptions/[id]/delete.ts`)

**What it does:**
1. Drops subscription on **target** database
2. Optionally drops publication on **source** (default: false)
3. Optionally drops slot on **source** (default: false)
4. Removes from monitoring database

**Issues Found:**
1. ✅ Correctly handles all cleanup operations
2. ✅ Provides options for what to drop
3. ⚠️ Slot is usually dropped automatically with subscription, but option is good

**Recommendations:**
- ✅ Current implementation is good
- Consider adding warning if slot has high lag before dropping

### ⚠️ ENABLE/DISABLE Subscription (`/api/subscriptions/[id]/enable.ts`)

**What it does:**
1. Enables/disables subscription on target
2. Updates monitoring database

**Issues Found:**
1. ✅ Works correctly
2. ⚠️ Doesn't verify subscription state before enabling/disabling

**Recommendations:**
- Add verification that subscription exists before altering

### ⚠️ MODIFY TABLES (`/api/subscriptions/[id]/modify-tables.ts`)

**What it does:**
1. Adds/removes tables from subscription
2. Uses `REFRESH PUBLICATION` to update subscription

**Issues Found:**
1. ⚠️ Doesn't update publication on source (only refreshes subscription)
2. ⚠️ Doesn't handle `data_copy` for new tables

**Recommendations:**
- When adding tables, should also add them to publication on source
- New tables added won't have initial data copy (limitation of REFRESH PUBLICATION)

### ❌ UPDATE Subscription (Missing)

**What's missing:**
- No endpoint to update subscription properties
- Cannot change `data_copy` after creation (PostgreSQL limitation)
- Cannot change connection string
- Cannot change publication

**Recommendations:**
- Document that `data_copy` cannot be changed after creation
- If connection string changes, need to drop and recreate

## Detailed Review by Operation

### CREATE Subscription Flow

```typescript
// Current flow:
1. Check if publication exists on source
   ✅ If not, create it
   ⚠️ If exists, skip (doesn't check if tables match)

2. Check if subscription exists on target
   ✅ If not, create it
   ⚠️ If exists, skip silently (should error)

3. Check if slot exists on source
   ✅ If exists, use create_slot = false
   ✅ If not, use create_slot = true

4. Create subscription with copy_data parameter
   ✅ Correctly uses dataCopy from request body
   ✅ Works for both true and false

5. Save to monitoring database
   ✅ Saves data_copy flag
```

**Issues:**
- Line 148: Silently skips if subscription exists
- Doesn't verify publication tables match requested tables

### DELETE Subscription Flow

```typescript
// Current flow:
1. Drop subscription on target
   ✅ Uses DROP SUBSCRIPTION IF EXISTS (safe)

2. Optionally drop publication on source
   ✅ Default: false (good, usually want to keep)

3. Optionally drop slot on source
   ✅ Default: false (good, usually auto-dropped)

4. Remove from monitoring database
   ✅ Also removes subscription_tables
```

**Status:** ✅ Good implementation

### Data Copy Handling

**For `data_copy = true`:**
- ✅ Correctly set in CREATE SUBSCRIPTION
- ✅ Saved to monitoring database
- ✅ Can be queried later for status display

**For `data_copy = false`:**
- ✅ Correctly set in CREATE SUBSCRIPTION
- ✅ Saved to monitoring database
- ⚠️ Subscriber starts empty (expected behavior)

**Limitations:**
- ⚠️ Cannot change `data_copy` after subscription creation (PostgreSQL limitation)
- ⚠️ If you need to copy data later, must drop and recreate subscription

## Recommendations

### 1. Improve CREATE endpoint

```typescript
// Suggested improvements:
- If subscription exists, return error with option to:
  a) Drop and recreate
  b) Use existing subscription
  c) Cancel operation

- If publication exists but tables differ:
  a) Add missing tables to publication
  b) Warn about tables not in publication
```

### 2. Add UPDATE endpoint (for limited updates)

```typescript
// What can be updated:
- Description
- Enabled/disabled state (already exists)
- Tables (already exists via modify-tables)

// What CANNOT be updated (PostgreSQL limitation):
- data_copy (must drop and recreate)
- Connection string (must drop and recreate)
- Publication name (must drop and recreate)
```

### 3. Improve error handling

```typescript
// Better error messages for:
- Subscription already exists
- Slot already exists (current: uses create_slot=false, good)
- Publication tables mismatch
- Connection failures
```

### 4. Add validation

```typescript
// Validate before creating:
- Check if tables exist on source
- Check if tables exist on target (for data_copy=true)
- Verify user has required privileges
- Check wal_level = logical on source
```

## Testing Checklist

### CREATE with data_copy=true
- [ ] Creates publication on source
- [ ] Creates subscription on target
- [ ] Creates slot on source (if doesn't exist)
- [ ] Uses existing slot (if exists)
- [ ] Saves data_copy=true to monitoring DB
- [ ] Initial data copy starts

### CREATE with data_copy=false
- [ ] Creates publication on source
- [ ] Creates subscription on target
- [ ] Creates slot on source (if doesn't exist)
- [ ] Uses existing slot (if exists)
- [ ] Saves data_copy=false to monitoring DB
- [ ] No initial data copy (subscriber starts empty)

### DELETE
- [ ] Drops subscription on target
- [ ] Optionally drops publication on source
- [ ] Optionally drops slot on source
- [ ] Removes from monitoring DB
- [ ] Handles errors gracefully

### Edge Cases
- [ ] Subscription already exists
- [ ] Slot already exists
- [ ] Publication already exists with different tables
- [ ] Connection failures
- [ ] Invalid credentials

## Code Improvements Needed

### 1. CREATE endpoint improvements

```typescript
// pages/api/subscriptions/create.ts

// Add after line 147:
if (subCheck.rows[0].count !== '0') {
  return res.status(409).json({
    error: 'Subscription already exists',
    details: `Subscription '${subscriptionName}' already exists on target database`,
    options: [
      'Drop existing subscription and recreate',
      'Use existing subscription',
      'Cancel operation'
    ]
  });
}

// Add publication table verification:
const pubTablesCheck = await sourcePool.query(`
  SELECT tablename FROM pg_publication_tables 
  WHERE pubname = $1
`, [publicationName]);

const existingTables = pubTablesCheck.rows.map(r => r.tablename);
const missingTables = tables.filter(t => !existingTables.includes(t));

if (missingTables.length > 0 && pubCheck.rows[0].count !== '0') {
  // Add missing tables to existing publication
  for (const table of missingTables) {
    await sourcePool.query(`
      ALTER PUBLICATION ${escapedPubName} ADD TABLE "${table.replace(/"/g, '""')}"
    `);
  }
}
```

### 2. DELETE endpoint improvements

```typescript
// pages/api/subscriptions/[id]/delete.ts

// Add before dropping slot:
if (dropSlot && slotName) {
  // Check slot lag
  const slotInfo = await sourcePool.query(`
    SELECT 
      pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as lag_bytes
    FROM pg_replication_slots
    WHERE slot_name = $1
  `, [slotName]);
  
  if (slotInfo.rows[0]?.lag_bytes > 1073741824) { // > 1GB
    // Warn about high lag
  }
}
```

### 3. Add UPDATE endpoint (limited)

```typescript
// pages/api/subscriptions/[id]/update.ts (NEW)

// Only allow updating:
- description
- enabled state (already exists)
- tables (already exists via modify-tables)

// Document that data_copy cannot be changed
```

## Summary

### ✅ What Works Well
1. CREATE handles `data_copy` correctly for both true/false
2. CREATE handles existing slot correctly
3. DELETE properly cleans up both source and target
4. DELETE provides options for what to drop

### ⚠️ Issues to Fix
1. CREATE silently skips if subscription exists (should error)
2. CREATE doesn't verify publication tables match
3. No way to update subscription properties (PostgreSQL limitation)
4. Missing validation before creation

### 📝 Documentation Needed
1. Document that `data_copy` cannot be changed after creation
2. Document that connection string changes require drop/recreate
3. Document publication table management

