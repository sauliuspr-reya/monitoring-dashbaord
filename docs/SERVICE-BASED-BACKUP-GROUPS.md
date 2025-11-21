# Service-Based Backup Groups

**Version**: 1.0.4  
**Feature**: Batch backups by service ownership

---

## Overview

Instead of manually selecting tables one by one, you can now **group tables by service** and create backup batches based on which service owns the data.

### Use Cases

1. **Service Migration**: Migrate `fast-indexer` service → backup only its tables (positions, orders)
2. **Service Rollout**: New GCP deployment → replicate service-by-service
3. **Incremental Migration**: Start with small services, gradually add larger ones
4. **Cleanup Migration**: Backup "everything else" that's not assigned to any service

---

## How It Works

### 1. Service Detection

The system analyzes PostgreSQL `application_name` from active connections to determine which service writes to which tables.

```sql
-- Behind the scenes
SELECT 
    application_name,
    schemaname || '.' || tablename as table_name,
    COUNT(*) as writes
FROM pg_stat_activity
WHERE application_name IS NOT NULL
GROUP BY application_name, table_name
```

### 2. Table Assignment

Tables are assigned to services based on write activity:

- **Exclusive Ownership**: Table written by only ONE service → assigned to that service
- **Shared Tables**: Table written by MULTIPLE services → grouped as "shared-tables"
- **Ungrouped Tables**: No recent writes from any service → "ungrouped" category

### 3. Backup Batch Creation

Select services → All their tables are included in the backup batch automatically.

---

## User Workflow

### Step 1: Navigate to Service Groups

```
Dashboard → Backup & Restore → Service-Based Groups
OR
Direct URL: /backup/service-groups
```

### Step 2: Select Services

**Example 1: Backup a specific service**

1. Check the box next to `fast-indexer`
2. You'll see all its tables (e.g., `positions`, `orders`)
3. Click "Create Backup Batch"

**Example 2: Backup multiple services**

1. Check `api-service`
2. Check `fast-indexer`
3. Check `notification-service`
4. All tables from all 3 services selected
5. Click "Create Backup Batch"

**Example 3: Backup everything else**

1. Check `🗂️ Ungrouped Tables`
2. This selects all tables NOT assigned to any service
3. Uncheck any large tables you want to exclude
4. Click "Create Backup Batch"

### Step 3: Exclude Large Tables

If a service has a very large table you don't want to backup:

1. Select the service
2. The table list expands
3. Uncheck specific tables to exclude them
4. The selection summary updates automatically

### Step 4: Create Backup

Click "Create Backup Batch" → redirects to backup creation with pre-selected tables.

---

## UI Features

### Service Cards

Each service shows:
- ✅ **Service Name**: e.g., "fast-indexer", "api-de", "notification-service"
- 📊 **Table Count**: Number of tables owned by this service
- 💾 **Total Size**: Combined size of all tables
- 📋 **Table List**: Expandable list when selected

### Selection Summary

Shows at the top when you select services:
```
Selected: 3 service(s), 45 table(s)
Total size: 12.5 GB (2 tables excluded)
```

### Analysis Window

Adjust how far back to look for write activity:
- Last hour
- Last 6 hours
- Last 24 hours (default)
- Last week

Longer windows = more accurate service detection, but slower query.

---

## API Endpoint

### `/api/backup/service-groups`

**Parameters**:
- `connectionString`: Source database connection string
- `hours`: Analysis window (default: 24)
- `minWrites`: Minimum writes to consider (default: 5)

**Response**:
```json
{
  "serviceGroups": [
    {
      "serviceName": "fast-indexer",
      "tables": ["public.positions", "public.orders"],
      "totalSize": "5.2 GB",
      "sizeBytes": 5580357632
    },
    {
      "serviceName": "api-de",
      "tables": ["public.users", "public.sessions"],
      "totalSize": "1.8 GB",
      "sizeBytes": 1932735283
    }
  ],
  "ungrouped": {
    "tables": ["public.logs", "public.audit_trail"],
    "totalSize": "800 MB",
    "sizeBytes": 838860800
  },
  "tableSizes": {
    "public.positions": {
      "sizeBytes": 3221225472,
      "sizeHuman": "3.0 GB"
    },
    ...
  },
  "summary": {
    "totalTables": 120,
    "assignedTables": 85,
    "ungroupedTables": 35,
    "serviceCount": 8
  }
}
```

---

## Example Scenarios

### Scenario 1: Migrate `fast-indexer` Service

**Goal**: Move `fast-indexer` from AWS to GCP

**Steps**:
1. Open Service Groups page
2. Select `fast-indexer` checkbox
3. Review tables: `positions`, `orders`, `trades`
4. Exclude `trades` if it's too large (uncheck it)
5. Create Backup Batch
6. Backup runs with just those 2 tables
7. Restore to GCP
8. Create subscription for continuous replication

**Result**: `fast-indexer` migrated independently, other services unaffected!

---

### Scenario 2: Backup "Everything Else"

**Goal**: After migrating key services, backup remaining tables

**Steps**:
1. Select services you've already migrated:
   - `fast-indexer` ✅
   - `api-service` ✅
   - `notification-service` ✅
2. These are now handled, so select `🗂️ Ungrouped Tables`
3. Review the list: old tables, logs, audit trails, etc.
4. Exclude massive log tables if needed
5. Create Backup Batch for all remaining tables

**Result**: Complete migration without manually tracking which tables you've done!

---

### Scenario 3: Shared Tables

**Goal**: Handle tables written by multiple services

If tables appear in `shared-tables` group:
- These are written by multiple services
- Back them up together OR
- Assign them to the primary service manually

---

## Best Practices

### 1. Start Small

Migrate one service at a time:
```
Day 1: fast-indexer (small, 2 tables)
Day 2: api-service (medium, 10 tables)
Day 3: notification-service (small, 3 tables)
...
Day N: ungrouped tables (cleanup)
```

### 2. Check Service Assignments

Before backing up, verify:
```sql
-- On SOURCE database
SELECT 
    application_name,
    COUNT(DISTINCT tablename) as table_count
FROM pg_stat_activity
WHERE application_name IS NOT NULL
GROUP BY application_name
ORDER BY COUNT(DISTINCT tablename) DESC;
```

Make sure services are correctly identified!

### 3. Exclude Large Tables Initially

For first migration attempt:
- Exclude tables > 100GB
- Verify everything works
- Add large tables later in batches

### 4. Use Longer Analysis Windows

For production:
- Use "Last week" analysis window
- More accurate service detection
- Catches infrequently updated tables

### 5. Monitor Table Assignments

Regularly refresh the service groups:
- New tables may be added
- Services may change behavior
- Keep groupings up-to-date

---

## Troubleshooting

### Problem: Service Not Showing Up

**Cause**: No recent write activity detected

**Solution**:
1. Increase analysis window (try "Last week")
2. Check if service is actually writing:
   ```sql
   SELECT application_name, COUNT(*)
   FROM pg_stat_activity
   WHERE application_name LIKE '%your-service%'
   GROUP BY application_name;
   ```
3. Verify service sets `application_name` in connection string

---

### Problem: Too Many Tables in "Ungrouped"

**Cause**: Tables not recently written by any service

**Solution**:
- These might be old/deprecated tables
- Or infrequently updated tables (extend analysis window)
- Or tables accessed via generic connections (no `application_name`)

---

### Problem: Shared Tables Group Too Large

**Cause**: Multiple services writing to same tables

**Solution**:
1. Identify primary owner of each table
2. Manually create custom backup batch
3. Or backup shared tables separately

---

## Configuration

### Environment Variables

Add to `.env.local`:

```bash
# Service detection sensitivity
SERVICE_DETECTION_MIN_WRITES=5  # Min writes to assign table to service
SERVICE_DETECTION_WINDOW_HOURS=24  # Default analysis window
```

### Database Requirements

Requires:
- PostgreSQL 12+
- `pg_stat_activity` access
- `pg_stat_statements` (optional, for better tracking)

---

## Roadmap / Future Enhancements

- [ ] **Auto-detect service groupings** from Docker/Kubernetes labels
- [ ] **Service dependency graph**: Show which services depend on which tables
- [ ] **Recommended migration order**: Suggest which services to migrate first
- [ ] **Table size warnings**: Alert when service has very large tables
- [ ] **Cross-database service tracking**: Track services across multiple databases
- [ ] **Historical service activity**: Show service write trends over time

---

## Related Documentation

- [Backup & Restore Workflow](./BACKUP-TO-SUBSCRIPTION-WORKFLOW.md)
- [Backup Slot Restoration](./BACKUP-SLOT-RESTORATION-FIX.md)
- [Replication Slot Reference](./REPLICATION-SLOT-REFERENCE.md)

---

## Summary

**Service-Based Backup Groups** make it easy to:
- ✅ Batch backups by service ownership
- ✅ Migrate services incrementally
- ✅ Exclude large tables easily
- ✅ Track which tables belong to which services
- ✅ Handle "everything else" in one go

**Navigate to**: `/backup/service-groups` to get started! 🚀
