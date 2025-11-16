# Row Count Methods - Performance Comparison

## Overview

Getting row counts in PostgreSQL can be done in several ways, each with different trade-offs:

## Methods (Fastest to Slowest)

### 1. `pg_stat_user_tables.n_live_tup` ⭐ **BEST CHOICE**
- **Speed**: ⚡⚡⚡⚡⚡ Very fast (cached statistics)
- **Accuracy**: ✅✅✅✅ Very accurate (updated by autovacuum)
- **Update frequency**: Updated by autovacuum (usually within minutes)
- **Use case**: Production monitoring, dashboards

```sql
SELECT n_live_tup 
FROM pg_stat_user_tables 
WHERE schemaname = 'public' AND relname = 'orders';
```

**Pros:**
- Most accurate estimate available
- Automatically updated by autovacuum
- No manual ANALYZE needed
- Fast (cached in memory)

**Cons:**
- May be slightly stale (minutes old)
- Requires autovacuum to be running

### 2. `pg_class.reltuples` (Current Method)
- **Speed**: ⚡⚡⚡⚡⚡ Very fast (cached statistics)
- **Accuracy**: ✅✅✅ Moderate (can be stale)
- **Update frequency**: Only updated by ANALYZE (manual or scheduled)
- **Use case**: Quick estimates when autovacuum hasn't run

```sql
SELECT reltuples::bigint 
FROM pg_class 
WHERE relname = 'orders' 
  AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
```

**Pros:**
- Very fast
- Always available

**Cons:**
- Can be very stale after restore (until ANALYZE runs)
- Less accurate than `n_live_tup`

### 3. `COUNT(*)` - Exact Count
- **Speed**: ⚡ Very slow (scans entire table)
- **Accuracy**: ✅✅✅✅✅ Perfect (exact count)
- **Use case**: Only for small tables (< 100K rows) or when exact count is critical

```sql
SELECT COUNT(*) FROM orders;
```

**Pros:**
- Exact count
- Always accurate

**Cons:**
- **VERY SLOW** on large tables (can take minutes/hours)
- Locks table during count
- Kills database performance

## Recommended Approach

**Use `pg_stat_user_tables.n_live_tup` as primary, fallback to `reltuples`:**

```sql
SELECT 
  COALESCE(s.n_live_tup::bigint, c.reltuples::bigint, 0) as estimated_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid AND s.schemaname = n.nspname
WHERE c.relname = 'orders' 
  AND n.nspname = 'public';
```

This gives you:
- Best accuracy (`n_live_tup` when available)
- Fallback to `reltuples` if stats not available
- Fast performance (both are cached)

## When to Use Each Method

| Scenario | Recommended Method |
|----------|-------------------|
| Dashboard monitoring | `n_live_tup` (or `reltuples` fallback) |
| After restore | `n_live_tup` (more accurate) |
| Small tables (< 100K) | `COUNT(*)` (exact, fast enough) |
| Large tables (> 1M) | `n_live_tup` or `reltuples` (never COUNT(*)) |
| Real-time accuracy needed | `COUNT(*)` (but expect performance hit) |

## Performance Impact

For a table with 31M rows:
- `n_live_tup`: ~1ms (cached)
- `reltuples`: ~1ms (cached)
- `COUNT(*)`: ~30-60 seconds (full table scan)

## Implementation

The dashboard now uses:
1. `n_live_tup` (primary) - most accurate
2. `reltuples` (fallback) - if stats not available
3. `COUNT(*)` (only for small tables < 100K rows)

This provides the best balance of accuracy and performance.

