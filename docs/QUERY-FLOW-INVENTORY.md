# Query Flow Inventory - `/api/subscriptions/[id]/tables`

## Frontend Flow

1. **Component**: `ReplicationStatus.tsx`
   - Calls: `GET /api/subscriptions/${subscriptionId}/tables?timeframe=${rateOfChangeTimeframe}`
   - Also calls: `GET /api/subscriptions/${subscriptionId}/logs` (in parallel)

## Backend Query Flow

### Step 1: Initial Setup (Monitoring DB)
- **Query 1**: `SELECT * FROM subscriptions WHERE id = $1`
  - **Database**: Monitoring DB
  - **Purpose**: Get subscription details
  - **Speed**: Fast (indexed lookup)

### Step 2: Application Tracking (SOURCE & TARGET DBs)
- **Service**: `ApplicationTrackingService.getWriteStatsByApplication()`
- **Called**: Twice in parallel (source + target)
- **Queries per call**:
  1. `getAllActiveConnections()` - Query pg_stat_activity
  2. `getWriteActivitySummary()` - Query pg_stat_activity with joins
  3. `checkExtension('pg_stat_statements')` - Check if extension exists
  4. `getHistoricalWriteCounts()` - Query pg_stat_statements (if extension exists)
- **Total**: ~8 queries (4 per database × 2 databases)
- **Speed**: Can be SLOW if pg_stat_statements is large

### Step 3: Get Publication Tables (SOURCE DB)
- **Query 2**: `SELECT schemaname || '.' || tablename FROM pg_publication_tables WHERE pubname = $1`
  - **Database**: Source DB
  - **Purpose**: Get list of tables in publication
  - **Speed**: Fast

### Step 4: Bulk Source Stats (SOURCE DB)
- **Query 3**: Bulk query for ALL tables
  ```sql
  SELECT 
    n.nspname || '.' || c.relname as table_name,
    c.reltuples::bigint as estimated_rows,
    pg_total_relation_size(c.oid) as size
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname || '.' || c.relname = ANY($1)
  ```
  - **Database**: Source DB
  - **Purpose**: Get estimates and sizes for all 141 tables
  - **Speed**: Fast (single query)

### Step 5: Bulk Target Stats (TARGET DB)
- **Query 4**: Bulk query for ALL tables
  ```sql
  SELECT 
    n.nspname || '.' || c.relname as table_name,
    c.reltuples::bigint as estimated_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname || '.' || c.relname = ANY($1)
  ```
  - **Database**: Target DB
  - **Purpose**: Get estimates for all 141 tables
  - **Speed**: Fast (single query)

### Step 6: Exact Counts for Small Tables (SOURCE & TARGET DBs)
- **Queries 5-N**: `SELECT COUNT(*) FROM table` (only for tables < 100K rows)
  - **Database**: Source + Target DBs
  - **Purpose**: Get exact counts for small tables only
  - **Count**: ~10-20 tables × 2 queries each = ~20-40 queries
  - **Batched**: 3 at a time
  - **Speed**: SLOW (COUNT(*) is expensive, even on small tables)

### Step 7: Historical Metrics (MONITORING DB)
- **Query 5**: Check column name
  ```sql
  SELECT column_name FROM information_schema.columns 
  WHERE table_name = 'table_replication_metrics' 
    AND column_name IN ('subscription_id', 'group_id')
  ```
- **Query 6**: Bulk historical data
  ```sql
  SELECT DISTINCT ON (table_name)
    table_name, source_row_count, timestamp
  FROM table_replication_metrics
  WHERE ${metricsIdColumn} = $1
    AND table_name = ANY($2)
    AND timestamp < NOW() - INTERVAL '1 minute'
    AND timestamp > NOW() - INTERVAL '${timeframeMinutes} minutes'
  ORDER BY table_name, timestamp DESC
  ```
  - **Database**: Monitoring DB
  - **Purpose**: Get historical row counts for rate calculations
  - **Speed**: Fast (indexed lookup)

### Step 8: Store Metrics (MONITORING DB)
- **Queries 7-N**: INSERT/UPDATE for each table (batched in groups of 20)
  ```sql
  INSERT INTO table_replication_metrics (...) VALUES (...)
  ON CONFLICT (...) DO UPDATE SET ...
  ```
  - **Database**: Monitoring DB
  - **Count**: ~141 tables ÷ 20 = ~7 batches
  - **Speed**: Medium (batched, but still many writes)

## Total Query Count

### Fast Queries (Bulk)
- Monitoring DB: 3 queries (subscription lookup, column check, historical metrics)
- Source DB: 2 queries (publication tables, bulk stats)
- Target DB: 1 query (bulk stats)
- **Subtotal**: 6 fast bulk queries

### Slow Queries
- Application Tracking: ~8 queries (4 per DB × 2 DBs)
- COUNT(*) queries: ~20-40 queries (10-20 tables × 2 DBs, batched)
- Metrics storage: ~7 batches of 20 = ~140 INSERT queries
- **Subtotal**: ~155-165 queries

### **TOTAL: ~161-171 queries per request**

## Performance Bottlenecks

1. **Application Tracking Service** (~8 queries)
   - Queries `pg_stat_activity` and `pg_stat_statements`
   - Can be slow if these views are large
   - **Fix**: Make this optional or cache results

2. **COUNT(*) Queries** (~20-40 queries)
   - Even batched, COUNT(*) is slow
   - **Fix**: Already optimized to only small tables, but could disable entirely

3. **Metrics Storage** (~140 INSERT queries)
   - Writing metrics for all 141 tables
   - **Fix**: Could batch more aggressively or make async

4. **Sequential Processing**
   - Some steps wait for previous steps
   - **Fix**: Could parallelize more operations

## Recommendations

1. **Make Application Tracking Optional**: Add query param `?includeWriters=false`
2. **Disable COUNT(*) Entirely**: Use estimates for all tables
3. **Make Metrics Storage Async**: Don't wait for metrics to be stored
4. **Add Caching**: Cache application tracking results for 5-10 minutes
5. **Add Timeout**: Set explicit timeout on the endpoint (e.g., 30 seconds)

