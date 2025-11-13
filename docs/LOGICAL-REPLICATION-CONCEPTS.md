# PostgreSQL Logical Replication Concepts

## Overview

PostgreSQL **logical replication** allows you to replicate data between databases by streaming changes at the logical level (rows, columns) rather than at the physical level (WAL segments).

## Key Concepts

### 1. Publisher (Source Database)
The database that contains the original data and makes it available for replication.

**Requirements:**
- `wal_level = logical` in `postgresql.conf`
- User with `REPLICATION` privilege

### 2. Subscriber (Target Database)
The database that receives and applies changes from the publisher.

**Requirements:**
- Same table structure as publisher
- User with `CREATE SUBSCRIPTION` privilege
- Network access to publisher

### 3. Publication
A set of tables on the publisher that are made available for replication.

```sql
CREATE PUBLICATION my_publication FOR TABLE orders;
```

### 4. Subscription
A connection from subscriber to publisher that receives changes.

```sql
CREATE SUBSCRIPTION my_subscription
CONNECTION 'host=source port=5432 dbname=mydb user=repuser password=pass'
PUBLICATION my_publication
WITH (copy_data = true);
```

### 5. Replication Slot
A mechanism on the publisher that ensures WAL segments are retained until the subscriber has processed them.

- **Created automatically** when subscription is created (if `create_slot = true`)
- **Tracks progress** of the subscriber
- **Prevents WAL deletion** until subscriber catches up

## The `copy_data = true` Parameter

### What It Does

When `copy_data = true`:
1. **Initial Data Copy**: Existing data in published tables is copied from publisher to subscriber
2. **Then Ongoing Replication**: After copy completes, only new changes are replicated

When `copy_data = false`:
- Only new changes are replicated (no initial copy)
- Subscriber starts empty and only receives changes made after subscription creation

### Copy Process States

The subscription goes through these states (visible in `pg_subscription_rel`):

1. **`'i'` (initializing)**: Initial data copy is in progress
   - Data is being copied from publisher to subscriber
   - Table is locked on subscriber during copy
   - Can take hours/days for large tables

2. **`'d'` (data copy done)**: Initial copy completed
   - All existing data has been copied
   - Ready to apply ongoing changes

3. **`'s'` (synchronizing)**: Applying ongoing changes
   - Copy is done, now catching up on changes that occurred during copy
   - Gap between publisher and subscriber should be closing

4. **`'r'` (ready)**: Ready state
   - Usually means no copy was needed (table was already in sync)

### Monitoring Copy Progress

```sql
-- Check copy state
SELECT 
  c.relname,
  sr.srsubstate,
  CASE sr.srsubstate
    WHEN 'i' THEN 'Copying...'
    WHEN 'd' THEN 'Done'
    WHEN 's' THEN 'Syncing'
    WHEN 'r' THEN 'Ready'
  END as status
FROM pg_subscription_rel sr
JOIN pg_class c ON sr.srrelid = c.oid
WHERE c.relname = 'orders';
```

## How It Works

### Step-by-Step Process

1. **Create Publication** (on publisher)
   ```sql
   CREATE PUBLICATION orders_pub FOR TABLE orders;
   ```

2. **Create Subscription** (on subscriber)
   ```sql
   CREATE SUBSCRIPTION orders_sub
   CONNECTION '...' PUBLICATION orders_pub
   WITH (copy_data = true);
   ```

3. **Replication Slot Created** (on publisher, automatically)
   - Tracks subscriber's progress
   - Ensures WAL segments are retained

4. **Initial Data Copy** (if `copy_data = true`)
   - Subscriber connects to publisher
   - Copies all existing rows from `orders` table
   - State: `'i'` (initializing)

5. **Copy Completes**
   - State changes to `'d'` (data copy done)

6. **Ongoing Replication**
   - Publisher streams new changes via WAL
   - Subscriber applies changes
   - State: `'s'` (synchronizing)

7. **Steady State**
   - Subscriber is in sync with publisher
   - Only new changes are replicated

## Important Considerations

### 1. Schema Must Match
- Tables must have same structure on both sides
- Column names, types, and constraints must match
- Schema changes are NOT replicated automatically

### 2. Replication Slot Management
- Slots prevent WAL deletion (can cause disk space issues)
- Monitor slot lag: `pg_replication_slots.restart_lsn`
- Drop unused slots carefully

### 3. Performance During Copy
- Large tables can take hours/days to copy
- Use `reltuples` for row counts (not `COUNT(*)`)
- Monitor progress via `pg_subscription_rel.srsubstate`

### 4. Network Requirements
- Subscriber must connect to publisher
- Firewall rules must allow PostgreSQL port (5432)
- Connection string must be correct

## Official Documentation Links

### PostgreSQL Official Docs

1. **CREATE SUBSCRIPTION**
   - https://www.postgresql.org/docs/current/sql-createsubscription.html
   - Complete syntax and parameters

2. **Logical Replication - Subscription**
   - https://www.postgresql.org/docs/current/logical-replication-subscription.html
   - How subscriptions work

3. **CREATE PUBLICATION**
   - https://www.postgresql.org/docs/current/sql-createpublication.html
   - How to create publications

4. **Replication Slots**
   - https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS
   - Understanding replication slots

5. **Logical Replication Overview**
   - https://www.postgresql.org/docs/current/logical-replication.html
   - Complete logical replication guide

### Key Parameters Explained

**`copy_data = true/false`**
- `true`: Copy existing data during subscription creation
- `false`: Only replicate new changes (subscriber starts empty)

**`create_slot = true/false`**
- `true`: Create replication slot automatically
- `false`: Use existing slot (must exist on publisher)

**`slot_name = 'name'`**
- Name of the replication slot on publisher
- Must be unique

**`enabled = true/false`**
- `true`: Subscription is active
- `false`: Subscription is paused

**`streaming = parallel`**
- Enables parallel apply of changes (PostgreSQL 13+)
- Improves performance for large transactions

## Common Issues

### "replication slot already exists"
- Slot exists but subscription doesn't
- **Solution**: Use `create_slot = false` or drop slot first

### "subscription already exists"
- Subscription was created before
- **Solution**: Drop existing subscription first

### Copy is very slow
- Normal for large tables (30M+ rows)
- **Solution**: Monitor progress, be patient, use `reltuples` for counts

### Gap not closing
- Check `pg_subscription_rel.srsubstate`
- If stuck at `'i'`, check for errors in logs
- Verify network connectivity

## Best Practices

1. **Monitor Progress**: Check `pg_subscription_rel` regularly
2. **Use Approximate Counts**: Use `reltuples` for large tables
3. **Check Slot Lag**: Monitor `pg_replication_slots` for WAL accumulation
4. **Verify Data**: Compare row counts after copy completes
5. **Handle Errors**: Check `pg_stat_subscription` for worker errors

## Example: Complete Setup

```sql
-- 1. On PUBLISHER: Create publication
CREATE PUBLICATION orders_pub FOR TABLE orders;

-- 2. On SUBSCRIBER: Create subscription with data copy
CREATE SUBSCRIPTION orders_sub
CONNECTION 'host=source port=5432 dbname=mydb user=repuser password=pass'
PUBLICATION orders_pub
WITH (
  create_slot = true,
  slot_name = 'orders_sub',
  copy_data = true,  -- ✅ Copy existing data
  enabled = true,
  streaming = parallel
);

-- 3. Monitor progress
SELECT 
  c.relname,
  sr.srsubstate,
  CASE sr.srsubstate
    WHEN 'i' THEN 'Copying...'
    WHEN 'd' THEN 'Done'
    WHEN 's' THEN 'Syncing'
    ELSE 'Ready'
  END as status
FROM pg_subscription_rel sr
JOIN pg_class c ON sr.srrelid = c.oid
WHERE c.relname = 'orders';
```

