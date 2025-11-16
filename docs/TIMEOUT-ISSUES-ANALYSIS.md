# Database Timeout Issues - Root Cause Analysis

## The Problem

You're experiencing frequent database connection timeouts on a **new Cloud SQL instance**. This is **NOT normal** and indicates a fundamental architectural issue.

## Root Cause: Connection Pool Exhaustion

### The Issue

Your code runs queries for **ALL tables in parallel** using `Promise.all()`. For a subscription with 141 tables, this means:

1. **141+ concurrent queries** hitting the database simultaneously
2. Each table query performs **4-5 database operations**:
   - Source estimate query
   - Source count query  
   - Target count query
   - Source size query
   - Historical data query

3. **Total concurrent operations: 141 × 5 = 705+ queries**

4. Your connection pool is configured with `max: 10` connections

5. **Result**: 695+ queries queue up, waiting for available connections → **timeouts**

### Why New Cloud SQL Instances Are More Vulnerable

1. **Smaller default connection limits**: New instances often have lower `max_connections` settings
2. **Shared resources**: Lower-tier instances share CPU/memory
3. **Cold start**: New instances may have slower query planning
4. **No connection pooling**: Each API request creates new pools (not reused)

## Evidence from Your Logs

```
[subscriptions/.../tables] Historical query failed for trading_stats_account_market: timeout exceeded
[subscriptions/.../tables] Historical query failed for FundingRateSeries: timeout exceeded
[subscriptions/.../tables] Historical query failed for AccountProfile: timeout exceeded
```

These errors occur because:
- All 141 tables are queried simultaneously
- Connection pool (max 10) is exhausted
- Queries wait in queue → timeout after 60 seconds

## Solutions Implemented

### 1. **Batched Query Processing** ✅

Changed from:
```typescript
// BAD: All tables at once
const tableStats = await Promise.all(
  tables.map(async (tableName) => { /* query */ })
);
```

To:
```typescript
// GOOD: Process in batches of 5
const tableStats = await processInBatches(
  tables,
  5, // Only 5 tables at a time
  async (tableName) => { /* query */ }
);
```

**Impact**: Reduces concurrent queries from 141 to 5, preventing pool exhaustion.

### 2. **Connection Retry Logic** ✅

Added exponential backoff retry for transient connection errors:
- 3 retries with 1s, 2s, 4s delays
- Only retries on connection errors (not auth/syntax errors)

### 3. **Improved Connection Pool Configuration** ✅

- Increased `idleTimeoutMillis` to 60s (prevent premature closures)
- Added error handlers for connection terminations
- Better logging for debugging

## Additional Recommendations

### 1. **Run the Diagnostic Script**

```bash
./scripts/diagnose-timeout-issues.sh
```

This will show:
- Current connection count vs max
- Long-running queries
- Cloud SQL instance configuration
- Network latency

### 2. **Optimize Queries**

**Current**: Using `COUNT(*)` for row counts (slow on large tables)
**Better**: Use `pg_class.reltuples` for estimates (already implemented for >1M rows)

**Consider**:
- Cache table metadata (row counts, sizes) - update periodically
- Use materialized views for frequently accessed stats
- Add indexes on frequently queried columns

### 3. **Connection Pool Caching**

**Current**: Each API request creates new pools
**Better**: Cache and reuse pools per connection string

```typescript
// Pseudo-code
const poolCache = new Map<string, Pool>();

function getCachedPool(connectionString: string): Pool {
  if (!poolCache.has(connectionString)) {
    poolCache.set(connectionString, createSourceTargetPool(connectionString));
  }
  return poolCache.get(connectionString)!;
}
```

### 4. **Cloud SQL Instance Sizing**

Check your instance tier:
```bash
gcloud sql instances describe <instance-name>
```

**Minimum recommendations**:
- **CPU**: At least 2 vCPUs (dedicated)
- **Memory**: 4GB+ 
- **Connections**: 100+ max_connections
- **Region**: Same region as your Kubernetes cluster

### 5. **Use Cloud SQL Proxy**

If pods are in different regions:
- Use Cloud SQL Proxy for better connection management
- Reduces network latency
- Handles connection pooling at proxy level

### 6. **Rate Limiting**

Add rate limiting to prevent overwhelming the database:
- Limit concurrent API requests
- Queue long-running operations
- Use background jobs for heavy queries

## Performance Expectations

### Before Fixes
- ❌ 141 tables = 705+ concurrent queries
- ❌ Connection pool exhausted
- ❌ Frequent timeouts
- ❌ Unreliable performance

### After Fixes
- ✅ 5 tables at a time = 25 concurrent queries max
- ✅ Connection pool stays within limits
- ✅ Automatic retry on transient errors
- ✅ Predictable, reliable performance

### Expected Performance
- **Small subscriptions** (< 20 tables): < 5 seconds
- **Medium subscriptions** (20-50 tables): 10-30 seconds  
- **Large subscriptions** (50-141 tables): 30-90 seconds

*Note: Times depend on table sizes, network latency, and Cloud SQL instance performance*

## Monitoring

Watch for these metrics:
1. **Connection pool usage**: Should stay < 80% of max
2. **Query duration**: Most queries should complete in < 5 seconds
3. **Timeout rate**: Should drop to near zero after fixes
4. **Error rate**: Connection errors should be rare

## Next Steps

1. ✅ **Deploy the fixes** (batching + retry logic)
2. 🔄 **Run diagnostic script** to check current state
3. 📊 **Monitor performance** after deployment
4. 🔧 **Optimize further** if needed (pool caching, query optimization)
5. ⬆️ **Upgrade Cloud SQL** if instance is under-provisioned

## Conclusion

The timeouts are **NOT normal** - they're caused by overwhelming a new Cloud SQL instance with too many concurrent queries. The fixes implemented (batching + retry) should resolve the issue. If problems persist, consider:

1. Upgrading Cloud SQL instance tier
2. Implementing connection pool caching
3. Further query optimization
4. Using Cloud SQL Proxy

