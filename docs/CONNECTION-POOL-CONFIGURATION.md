# Connection Pool Configuration

## Overview

Connection pools are configured to handle production workloads with multiple services connecting to the databases. The limits are configurable via environment variables to allow tuning per environment.

## Current Settings

### Monitoring Database Pool
- **Default**: 50 connections
- **Environment Variable**: `MONITORING_DB_MAX_CONNECTIONS`
- **Usage**: Dashboard API requests, background workers, metrics collection

### Source/Target Database Pools
- **Default**: 25 connections per pool
- **Environment Variable**: `SOURCE_TARGET_DB_MAX_CONNECTIONS`
- **Usage**: Each API request creates pools for source (AWS) and target (GCP) databases

## Configuration

### Environment Variables

Add to your `.env.local` or Kubernetes secrets:

```bash
# Monitoring database (dashboard internal DB)
MONITORING_DB_MAX_CONNECTIONS=50

# Source/Target databases (AWS RDS / GCP Cloud SQL)
SOURCE_TARGET_DB_MAX_CONNECTIONS=25
```

### Recommended Values by Environment

#### Development
```bash
MONITORING_DB_MAX_CONNECTIONS=20
SOURCE_TARGET_DB_MAX_CONNECTIONS=10
```

#### Staging
```bash
MONITORING_DB_MAX_CONNECTIONS=50
SOURCE_TARGET_DB_MAX_CONNECTIONS=25
```

#### Production
```bash
MONITORING_DB_MAX_CONNECTIONS=100
SOURCE_TARGET_DB_MAX_CONNECTIONS=50
```

## Connection Pool Math

### Total Connections Needed

For production with multiple services:

1. **Monitoring Database**:
   - Dashboard API: ~10-20 concurrent requests × 1 connection = 10-20
   - Background workers: ~5-10 connections
   - Metrics collection: ~5 connections
   - **Total needed**: ~20-35 connections
   - **Configured**: 50 (with headroom)

2. **Source/Target Databases**:
   - Each API request creates 2 pools (source + target)
   - With batching (5 tables at a time), each request uses ~10 connections
   - 10 concurrent API requests = 20 pools × 25 connections = 500 connections
   - **BUT**: Pools are created per-request and closed after, so actual usage is lower
   - **Configured**: 25 per pool (allows 2-3 concurrent heavy operations)

### Cloud SQL Connection Limits

Check your Cloud SQL instance's `max_connections`:

```sql
SELECT setting FROM pg_settings WHERE name = 'max_connections';
```

**Typical limits by tier**:
- **db-f1-micro**: 25 connections
- **db-g1-small**: 100 connections
- **db-n1-standard-1**: 100 connections
- **db-n1-standard-2**: 200 connections
- **db-n1-standard-4**: 400 connections
- **db-n1-standard-8**: 800 connections

**Important**: Ensure your Cloud SQL `max_connections` is higher than:
```
(Number of production services × their connection pools) + 
(Dashboard pools × concurrent requests) + 
(Background workers)
```

## Monitoring

### Check Current Connection Usage

```sql
-- On Cloud SQL (target)
SELECT 
    COUNT(*) as current_connections,
    (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_connections,
    ROUND(COUNT(*)::numeric / (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') * 100, 2) as usage_percent
FROM pg_stat_activity
WHERE datname = current_database();
```

### Check Connection Pool Status

The application logs connection pool initialization:
```
[db/connection] Initializing database pool: {
  host: '...',
  maxConnections: 50
}
```

## Troubleshooting

### "Too many connections" Error

**Symptoms**: 
- `FATAL: too many connections for role`
- Connection timeouts
- Queries failing

**Solutions**:
1. **Reduce pool sizes** (if Cloud SQL limit is low):
   ```bash
   SOURCE_TARGET_DB_MAX_CONNECTIONS=10
   ```

2. **Upgrade Cloud SQL instance** to higher tier with more connections

3. **Implement connection pool caching** (reuse pools instead of creating new ones per request)

4. **Reduce concurrent operations** (already done with batching)

### Connection Pool Exhaustion

**Symptoms**:
- Queries timing out
- "Connection terminated" errors
- Slow response times

**Solutions**:
1. **Increase pool sizes**:
   ```bash
   SOURCE_TARGET_DB_MAX_CONNECTIONS=50
   ```

2. **Check for connection leaks** (pools not being closed)

3. **Reduce query concurrency** (already done with batching to 5 tables)

## Best Practices

1. **Start conservative**: Use lower limits initially, monitor, then increase
2. **Monitor usage**: Check connection counts regularly
3. **Leave headroom**: Don't use 100% of Cloud SQL's max_connections
4. **Pool per environment**: Different limits for dev/staging/prod
5. **Close pools**: Always close pools in `finally` blocks (already implemented)

## Future Improvements

1. **Connection Pool Caching**: Reuse pools instead of creating new ones per request
2. **Connection Pooling Service**: Use PgBouncer or Cloud SQL Proxy for better pooling
3. **Dynamic Scaling**: Adjust pool sizes based on load
4. **Connection Monitoring**: Alert when usage exceeds thresholds

