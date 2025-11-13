# Setting Up Subscription with data_copy=true for Orders Table

## Prerequisites

1. **Source Database** (where orders table exists)
   - PostgreSQL 10+ with logical replication enabled
   - `wal_level = logical` in postgresql.conf
   - User with `REPLICATION` privilege

2. **Target Database** (where data will be replicated)
   - PostgreSQL 10+ 
   - User with `CREATE SUBSCRIPTION` privilege
   - Network access to source database

3. **Check Current Setup**
   ```sql
   -- On source: Check if logical replication is enabled
   SHOW wal_level;  -- Should be 'logical'
   
   -- On source: Check replication slots
   SELECT * FROM pg_replication_slots;
   
   -- On target: Check existing subscriptions
   SELECT * FROM pg_subscription;
   ```

## Step-by-Step Setup

### Step 1: Create Publication on Source Database

```sql
-- Connect to SOURCE database
-- Create publication for orders table
CREATE PUBLICATION orders_publication FOR TABLE orders;

-- Verify publication
SELECT * FROM pg_publication WHERE pubname = 'orders_publication';
SELECT * FROM pg_publication_tables WHERE pubname = 'orders_publication';
```

**Alternative: Add to existing publication**
```sql
-- If you already have a publication, add orders table to it
ALTER PUBLICATION <existing_publication_name> ADD TABLE orders;
```

### Step 2: Create Replication Slot (Optional - will be created automatically)

```sql
-- On SOURCE database
-- This is usually created automatically, but you can create it manually:
SELECT pg_create_logical_replication_slot('orders_subscription', 'pgoutput');
```

### Step 3: Create Subscription on Target Database

```sql
-- Connect to TARGET database
-- Replace connection details with your source database info
CREATE SUBSCRIPTION orders_subscription
CONNECTION 'host=<source_host> port=5432 dbname=<source_db> user=<replication_user> password=<password>'
PUBLICATION orders_publication
WITH (
  create_slot = true,
  slot_name = 'orders_subscription',
  copy_data = true,  -- ✅ This enables initial data copy
  enabled = true,
  streaming = parallel
);
```

**Connection String Format:**
- URL format: `postgresql://user:password@host:port/database`
- Connection string: `host=hostname port=5432 dbname=database user=username password=password`

### Step 4: Verify Subscription is Created

```sql
-- On TARGET database
SELECT 
  subname,
  subenabled,
  subpublications
FROM pg_subscription
WHERE subname = 'orders_subscription';
```

### Step 5: Monitor Initial Data Copy Progress

```sql
-- On TARGET database: Check copy state
SELECT 
  c.relname as table_name,
  sr.srsubstate as copy_state,
  CASE sr.srsubstate
    WHEN 'i' THEN '🔄 Initializing (copy in progress)'
    WHEN 'd' THEN '✅ Data copy done'
    WHEN 's' THEN '🔄 Synchronizing (applying changes)'
    WHEN 'r' THEN '✅ Ready'
    ELSE '❓ Unknown'
  END as status
FROM pg_subscription s
JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
JOIN pg_class c ON sr.srrelid = c.oid
WHERE s.subname = 'orders_subscription' AND c.relname = 'orders';
```

### Step 6: Monitor Row Count Progress

```sql
-- On TARGET database: Check row count (use reltuples for speed)
SELECT 
  relname,
  reltuples::bigint as approximate_row_count,
  pg_size_pretty(pg_total_relation_size('public.orders')) as table_size
FROM pg_class
WHERE relname = 'orders';

-- Compare with source (run on SOURCE database)
SELECT 
  relname,
  reltuples::bigint as source_row_count
FROM pg_class
WHERE relname = 'orders';
```

## Complete SQL Script

Save this as `setup-orders-subscription.sql`:

```sql
-- ============================================
-- Setup Subscription for Orders Table
-- with data_copy=true
-- ============================================

-- STEP 1: On SOURCE database
-- Create publication
CREATE PUBLICATION IF NOT EXISTS orders_publication FOR TABLE orders;

-- Verify
SELECT 'Publication created' as status, pubname FROM pg_publication WHERE pubname = 'orders_publication';
SELECT 'Tables in publication' as status, tablename FROM pg_publication_tables WHERE pubname = 'orders_publication';

-- STEP 2: On TARGET database
-- Create subscription with data_copy=true
-- ⚠️ REPLACE connection details below!
CREATE SUBSCRIPTION orders_subscription
CONNECTION 'host=YOUR_SOURCE_HOST port=5432 dbname=YOUR_SOURCE_DB user=YOUR_USER password=YOUR_PASSWORD'
PUBLICATION orders_publication
WITH (
  create_slot = true,
  slot_name = 'orders_subscription',
  copy_data = true,  -- ✅ Initial data copy enabled
  enabled = true,
  streaming = parallel
);

-- Verify subscription
SELECT 
  'Subscription created' as status,
  subname,
  subenabled,
  subpublications
FROM pg_subscription
WHERE subname = 'orders_subscription';

-- Monitor copy progress
SELECT 
  c.relname as table_name,
  sr.srsubstate as state,
  CASE sr.srsubstate
    WHEN 'i' THEN 'Copying...'
    WHEN 'd' THEN 'Done'
    WHEN 's' THEN 'Syncing'
    ELSE 'Unknown'
  END as status
FROM pg_subscription s
JOIN pg_subscription_rel sr ON s.oid = sr.srsubid
JOIN pg_class c ON sr.srrelid = c.oid
WHERE s.subname = 'orders_subscription';
```

## Using the Dashboard UI

You can also create the subscription through the dashboard:

1. Navigate to `/subscriptions/new`
2. Fill in:
   - **Name**: `orders_subscription`
   - **Source DB Connection**: Your source database connection string
   - **Target DB Connection**: Your target database connection string
   - **Tables**: Select `orders` table
   - **Copy existing data**: ✅ Check this box (enables `data_copy=true`)
3. Click "Create Subscription"

The dashboard will:
- Create the publication on source (if needed)
- Create the subscription on target with `copy_data = true`
- Save it to the monitoring database

## Troubleshooting

### Issue: "subscription already exists"

```sql
-- Check existing subscriptions
SELECT * FROM pg_subscription WHERE subname = 'orders_subscription';

-- If duplicate exists, drop it first
DROP SUBSCRIPTION IF EXISTS orders_subscription;
```

### Issue: "publication does not exist"

```sql
-- On SOURCE database: Create publication
CREATE PUBLICATION orders_publication FOR TABLE orders;
```

### Issue: "replication slot already exists"

```sql
-- On SOURCE database: Check slots
SELECT * FROM pg_replication_slots WHERE slot_name = 'orders_subscription';

-- Drop slot if needed (CAREFUL: only if subscription is dropped)
SELECT pg_drop_replication_slot('orders_subscription');
```

### Issue: Copy is very slow

For large tables (30M+ rows), the copy can take hours or days. Monitor progress:

```sql
-- Check copy state
SELECT srsubstate FROM pg_subscription_rel 
WHERE srrelid = 'orders'::regclass;

-- Check row count progress
SELECT reltuples::bigint FROM pg_class WHERE relname = 'orders';
```

### Issue: Connection errors

Verify:
1. Network connectivity between target and source
2. Firewall rules allow PostgreSQL port (5432)
3. Source database allows connections from target IP
4. User has `REPLICATION` privilege on source

```sql
-- On SOURCE: Check if user has replication privilege
SELECT rolname, rolreplication FROM pg_roles WHERE rolname = 'your_user';
```

## Monitoring Copy Progress

### Check Copy State

```sql
-- State 'i' = initializing (copying)
-- State 'd' = done (copy complete)
SELECT 
  c.relname,
  sr.srsubstate,
  CASE sr.srsubstate
    WHEN 'i' THEN 'Copying...'
    WHEN 'd' THEN '✅ Done'
    WHEN 's' THEN 'Syncing'
    ELSE 'Unknown'
  END as status
FROM pg_subscription_rel sr
JOIN pg_class c ON sr.srrelid = c.oid
WHERE c.relname = 'orders';
```

### Check Row Count Progress

```sql
-- Target (approximate count)
SELECT reltuples::bigint as target_rows FROM pg_class WHERE relname = 'orders';

-- Source (approximate count) - run on source DB
SELECT reltuples::bigint as source_rows FROM pg_class WHERE relname = 'orders';
```

### Use Dashboard Monitoring

The dashboard automatically tracks:
- Row counts (source vs target)
- Rate of change
- Copy progress
- Replication lag

Navigate to `/subscriptions/[id]` to see real-time progress.

## Important Notes

1. **Initial Copy Time**: For 30M rows, expect several hours to days depending on:
   - Network speed
   - Database load
   - Table size and indexes

2. **During Copy**: 
   - Table is locked on target during initial copy
   - New writes on source are queued and applied after copy completes
   - Monitor `pg_subscription_rel.srsubstate` to track progress

3. **After Copy Completes**:
   - State changes from `'i'` (initializing) to `'d'` (done)
   - Then to `'s'` (synchronizing) as ongoing changes are applied
   - Gap between source and target should close

4. **Performance**: 
   - Use `reltuples` for row counts (much faster than `COUNT(*)`)
   - Don't run `COUNT(*)` on large tables during copy

## Next Steps

After subscription is created:
1. Monitor copy progress using queries above
2. Use dashboard at `/subscriptions/[id]` for visual monitoring
3. Check rate of change to estimate completion time
4. Verify data integrity after copy completes

