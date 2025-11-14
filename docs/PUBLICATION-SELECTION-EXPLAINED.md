# Publication Selection in Subscriptions

## How Publications Work with Subscriptions

### Regular Subscription Creation (New Subscription)

When you create a subscription through `/subscriptions/new`:

1. **You DON'T select a publication** - it's **auto-generated** for you
2. The publication name is derived from your subscription name:
   - Subscription name: `my_subscription`
   - Publication name: `my_subscription_publication` (auto-generated)
3. The publication is created on the **source database** with the tables you select
4. The subscription then uses this auto-generated publication

**Example:**
```
User creates subscription: "orders_subscription"
System creates publication: "orders_subscription_publication"
System creates subscription using: "orders_subscription_publication"
```

### Subscription from Backup Task

When you create a subscription from a backup task (using the "Create Subscription" button):

1. **You use the EXISTING publication** from the backup task
2. The publication was already created during the backup process
3. The publication name is stored in the backup task (e.g., `backup_pub_1763045647601`)
4. The subscription uses this existing publication

**Why this matters:**
- The backup's publication contains the exact tables that were backed up
- Using the same publication ensures consistency
- The slot was already capturing changes for this publication

## When Do You Need to Select a Publication?

### Option 1: Use Existing Publication (Manual)

If you want to use an **existing publication** that was created outside the dashboard:

```sql
-- On source, check existing publications
SELECT pubname, COUNT(*) as table_count
FROM pg_publication_tables
GROUP BY pubname;

-- Then manually create subscription using that publication
CREATE SUBSCRIPTION my_sub
CONNECTION '...'
PUBLICATION existing_publication_name  -- Use existing publication
WITH (create_slot = true, ...);
```

**Note:** The current UI doesn't support selecting an existing publication. It always creates a new one.

### Option 2: Create New Publication (Current UI Behavior)

The dashboard always creates a new publication based on:
- Your subscription name
- The tables you select

## Publication vs Subscription Relationship

```
┌─────────────────────────────────────────────────────────┐
│ SOURCE DATABASE (Publisher)                            │
│                                                         │
│  Publication: orders_publication                        │
│    ├─ Table: orders                                    │
│    ├─ Table: order_items                                │
│    └─ Table: customers                                  │
│                                                         │
│  Replication Slot: orders_slot                         │
│    └─ Captures changes for: orders_publication          │
└─────────────────────────────────────────────────────────┘
                        │
                        │ (replicates via)
                        ▼
┌─────────────────────────────────────────────────────────┐
│ TARGET DATABASE (Subscriber)                           │
│                                                         │
│  Subscription: orders_subscription                       │
│    ├─ Uses Publication: orders_publication            │
│    ├─ Uses Slot: orders_slot                           │
│    └─ Replicates to: orders, order_items, customers    │
└─────────────────────────────────────────────────────────┘
```

## Key Points

1. **One publication can have multiple subscriptions** (one-to-many)
2. **One subscription uses one publication** (many-to-one)
3. **The publication defines which tables are replicated**
4. **The slot captures changes for the publication**

## Current Implementation

### Regular Subscription Creation
- ✅ Auto-creates publication based on subscription name
- ✅ Adds selected tables to the publication
- ❌ Doesn't allow selecting existing publication

### Subscription from Backup
- ✅ Uses existing publication from backup task
- ✅ Uses existing slot from backup task
- ✅ Ensures consistency with backup

## Future Enhancement Ideas

1. **Add publication selector** to subscription creation UI:
   - Show list of existing publications
   - Allow user to choose: "Create new" or "Use existing"
   - If using existing, show which tables are in that publication

2. **Publication management page**:
   - List all publications
   - Show which tables are in each
   - Show which subscriptions use each publication
   - Allow creating publications independently

3. **Multi-publication subscriptions**:
   - PostgreSQL supports subscribing to multiple publications
   - Could add UI to select multiple publications

