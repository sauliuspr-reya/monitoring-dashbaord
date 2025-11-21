# Backup Slot Restoration Fix

## Problem

When creating a subscription from an existing backup slot, the system was incorrectly creating a **NEW filtered publication** every time, instead of using the existing publication associated with the backup slot. This breaks zero-data-loss restoration.

### What Was Happening

1. User creates backup with slot: `backup_pub_1763713344411` + `backup_slot_1763713344411`
2. User restores backup to target database
3. User creates subscription via UI, selecting:
   - Existing publication: `backup_pub_1763713344411`
   - Replication slot: `backup_slot_1763713344411`
   - Custom tables: (selected subset of tables)
4. **System incorrectly created**: `aaa_subscription_filtered_publication` (NEW publication)
5. **Result**: Data loss - the slot was still tracking `backup_pub_1763713344411`, not the new filtered publication

## Why This Is Wrong

PostgreSQL replication slots are **tied to specific publications**:
- Slot starts capturing WAL changes for the publication's tables
- When you create a subscription with a different publication, the slot-publication association breaks
- Changes captured by the slot won't match the new publication's tables
- **Result**: Lost changes, data inconsistencies

## The Fix

### Code Changes

**File**: `/pages/api/subscriptions/create.ts`

1. Added detection for existing slot usage:
   ```typescript
   const usingExistingSlot = manualSlotName && slotExists;
   ```

2. Prevented filtered publication creation when using existing slots:
   ```typescript
   if (customTables && customTables.length > 0 && !usingExistingSlot) {
     // Create filtered publication
   } else if (usingExistingSlot && customTables && customTables.length > 0) {
     // Return error - cannot filter tables with existing slot
     return res.status(400).json({
       error: 'Cannot filter tables when using an existing replication slot',
       details: 'The replication slot is tied to a specific publication...',
       hint: 'Either use all tables from the publication, or use the /api/subscriptions/create-from-backup endpoint...'
     });
   }
   ```

**File**: `/pages/subscriptions/new.tsx`

Added UI warning when backup slot is detected with table filtering:
```tsx
{manualSlotName.startsWith('backup_slot_') && useExistingPublication && selectedTablesFromPub.size > 0 && (
  <div className="mt-2 p-2 bg-yellow-50 border border-yellow-300 rounded">
    <p>⚠️ Important: When using an existing backup slot, you must use ALL tables from the original publication.</p>
  </div>
)}
```

## Correct Workflow for Backup Restoration

### Option 1: Use Dedicated Backup Restoration Endpoint (Recommended)

```bash
POST /api/subscriptions/create-from-backup
{
  "backupTaskId": "abc-123",
  "subscriptionName": "my_subscription",
  "sourceDbConnection": "postgresql://...",
  "targetDbConnection": "postgresql://..."
}
```

This endpoint:
- ✅ Uses the exact slot and publication from the backup
- ✅ Sets `create_slot = false` (uses existing slot)
- ✅ Sets `copy_data = false` (data already restored)
- ✅ No table filtering (uses all tables from original publication)

### Option 2: Manual Via UI (With Restrictions)

1. Select existing publication (e.g., `backup_pub_1763713344411`)
2. Enter slot name in Advanced Options (e.g., `backup_slot_1763713344411`)
3. **DO NOT select custom tables** - leave table selection empty to use all tables
4. Set `copy_data = false` (data already restored)

### Option 3: Manual SQL (Direct Database)

```sql
-- On target database
CREATE SUBSCRIPTION my_subscription
CONNECTION 'host=... port=5432 dbname=... user=... password=...'
PUBLICATION backup_pub_1763713344411  -- Original publication from backup
WITH (
    create_slot = false,              -- Use existing slot
    slot_name = 'backup_slot_1763713344411',  -- Existing slot
    copy_data = false,                -- Data already restored
    enabled = true
);
```

## Table Filtering Restrictions

### ❌ Cannot Filter Tables When:
- Using an existing replication slot
- Slot was created during backup
- Restoring from a snapshot/backup

### ✅ Can Filter Tables When:
- Creating a NEW slot (not using existing)
- Creating a NEW publication
- Normal subscription creation (not restoration)

## Verification

After creating the subscription, verify it's using the correct slot and publication:

```sql
-- On target database
SELECT 
    subname,
    subslotname,
    subpublications,
    subenabled
FROM pg_subscription
WHERE subname = 'my_subscription';

-- Expected result:
-- subname: my_subscription
-- subslotname: backup_slot_1763713344411
-- subpublications: {backup_pub_1763713344411}
-- subenabled: true
```

## Migration Path for Existing Broken Subscriptions

If you already created subscriptions with filtered publications:

1. **Drop the broken subscription**:
   ```sql
   -- On target
   DROP SUBSCRIPTION aaa_subscription;
   ```

2. **Drop the incorrectly created filtered publication**:
   ```sql
   -- On source
   DROP PUBLICATION aaa_subscription_filtered_publication;
   ```

3. **Recreate using the correct endpoint**:
   - Use `/api/subscriptions/create-from-backup` endpoint
   - Or manually create with original publication + slot

## Related Files

- `/pages/api/subscriptions/create.ts` - Main subscription creation endpoint
- `/pages/api/subscriptions/create-from-backup.ts` - Dedicated backup restoration endpoint
- `/pages/subscriptions/new.tsx` - UI for creating subscriptions
- `/docs/BACKUP-TO-SUBSCRIPTION-WORKFLOW.md` - Complete backup workflow documentation
