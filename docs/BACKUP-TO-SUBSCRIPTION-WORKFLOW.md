# Backup to Subscription Workflow

This document explains the complete workflow from taking a backup with a replication slot to creating a subscription for continuous replication.

## Overview

When you create a backup with replication enabled, the system:
1. Creates a **publication** on the source database
2. Creates a **replication slot** on the source database
3. Takes a **backup snapshot** (pg_dump)
4. Stores the **slot name**, **publication name**, and **initial LSN** in the backup task

After the backup completes, you need to:
1. **Restore** the backup to the target database
2. **Create a subscription** using the existing slot (to avoid data loss)

## Step-by-Step Workflow

### Step 1: Create Backup with Replication Slot

When creating a backup, enable "Replication Snapshot" in the UI. This will:
- Create a publication (e.g., `backup_pub_1763045647601`)
- Create a replication slot (e.g., `backup_slot_1763045647601`)
- Capture the initial LSN (e.g., `11/ED193380`)
- Store all this information in the backup task

**Important:** The slot starts capturing changes immediately, even before the backup completes.

### Step 2: Restore Backup to Target

Use the restore functionality to restore the backup file to your target database:

```bash
# Via UI: Click "Restore" button on the backup file
# Or via API:
POST /api/backup/restore
{
  "filename": "backup_2025-11-13T14-54-07_.sql",
  "connectionString": "postgresql://user:pass@target-host:5432/dbname"
}
```

The restore uses `pg_restore` or `psql` depending on the backup format.

### Step 3: Create Subscription Using Existing Slot

**YES, you need to create a subscription** to continue replication after the restore.

When creating the subscription, you must:
- Use the **existing slot** (from the backup task)
- Set `create_slot = false` (to use the existing slot)
- Use the **publication name** from the backup task
- Set `copy_data = false` (data already restored)

## Selecting the Right Backup/Slot

When you have multiple backups, you need to identify which backup task contains the slot you want to use.

### Option 1: Via UI - Backup Tasks List

1. Go to `/backup` page
2. Find your backup task in the "Backup Tasks" table
3. Look at the **Details** column for:
   - **Replication Slot**: `backup_slot_1763045647601`
   - **Publication**: `backup_pub_1763045647601`
   - **Initial LSN**: `11/ED193380`
   - **Snapshot ID**: `snapshot_1763045647682`

### Option 2: Query Backup Tasks Database

```sql
SELECT 
    id,
    filename,
    slot_name,
    publication_name,
    slot_initial_lsn,
    snapshot_id,
    status,
    created_at
FROM backup_tasks
WHERE slot_name IS NOT NULL
  AND status = 'completed'
ORDER BY created_at DESC;
```

### Option 3: Check Source Database for Active Slots

```sql
-- List all replication slots
SELECT 
    slot_name,
    active,
    confirmed_flush_lsn,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag_size
FROM pg_replication_slots
WHERE slot_name LIKE 'backup_slot_%'
ORDER BY slot_name;
```

## Creating Subscription with Existing Slot

### Via API

```bash
POST /api/subscriptions/create
{
  "name": "my-subscription",
  "sourceDbConnection": "postgresql://user:pass@source-host:5432/dbname",
  "targetDbConnection": "postgresql://user:pass@target-host:5432/dbname",
  "customTables": ["table1", "table2"],
  "dataCopy": false,  // IMPORTANT: false because data already restored
  "useExistingSlot": true,  // Use existing slot
  "slotName": "backup_slot_1763045647601",  // From backup task
  "publicationName": "backup_pub_1763045647601"  // From backup task
}
```

### Manual SQL (if needed)

On the **target database**:

```sql
CREATE SUBSCRIPTION my_subscription
CONNECTION 'host=source-host port=5432 dbname=dbname user=user password=pass'
PUBLICATION backup_pub_1763045647601
WITH (
    create_slot = false,  -- Use existing slot
    slot_name = 'backup_slot_1763045647601',  -- Existing slot name
    copy_data = false,  -- Data already restored
    enabled = true
);
```

## Important Considerations

### 1. Slot Retention

The replication slot on the source database **retains WAL segments** until the subscriber consumes them. This means:
- If you don't create a subscription quickly, WAL will accumulate
- Monitor disk space on the source database
- If you abandon a backup, drop the slot to free WAL space

### 2. Multiple Backups

If you have multiple backups with slots:
- Each backup has its own slot and publication
- You can only use one slot per subscription
- Choose the most recent backup that matches your restore
- Older slots can be dropped if not needed

### 3. Slot vs Publication Matching

**Critical:** The slot and publication must match:
- The publication defines which tables are replicated
- The slot captures changes for those tables
- If you restore a backup but use a different publication, you'll have data inconsistencies

### 4. Initial LSN

The `slot_initial_lsn` tells you where the slot started capturing changes. This is useful for:
- Verifying the slot captured all changes during backup
- Troubleshooting replication lag
- Understanding the replication timeline

## Verification Queries

### Check Slot Status (on source)

```sql
SELECT 
    slot_name,
    active,
    confirmed_flush_lsn,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag_size
FROM pg_replication_slots
WHERE slot_name = 'backup_slot_1763045647601';
```

### Check Subscription Status (on target)

```sql
SELECT 
    subname,
    subenabled,
    subslotname,
    sent_lsn,
    apply_lsn,
    pg_size_pretty(pg_wal_lsn_diff(sent_lsn, apply_lsn)) AS lag
FROM pg_stat_subscription
WHERE subname = 'my_subscription';
```

### Verify Tables Match

```sql
-- On source (publication tables)
SELECT tablename FROM pg_publication_tables 
WHERE pubname = 'backup_pub_1763045647601'
ORDER BY tablename;

-- On target (subscription should replicate these)
-- Check via pg_subscription_rel or your monitoring dashboard
```

## Cleanup

If you need to clean up:

```sql
-- Drop subscription (on target)
DROP SUBSCRIPTION my_subscription;

-- Drop slot (on source) - ONLY if subscription is dropped
SELECT pg_drop_replication_slot('backup_slot_1763045647601');

-- Drop publication (on source)
DROP PUBLICATION backup_pub_1763045647601;
```

## UI Workflow (Future Enhancement)

A future UI enhancement could:
1. Show "Create Subscription" button on completed backup tasks with slots
2. Pre-fill the subscription form with slot/publication from the backup task
3. Automatically set `create_slot = false` and `copy_data = false`
4. Link backup tasks to subscriptions for easy tracking

