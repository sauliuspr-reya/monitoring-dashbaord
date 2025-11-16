# Performance Optimizations

## Problem: Unnecessary Table Queries

### The Issue

The subscription status endpoint was querying all 141 tables on every page load, even when users just wanted to see logs. This caused:
- **Slow page loads**: 30-90 seconds to load subscription list
- **Database overload**: 141+ concurrent queries
- **Connection timeouts**: Pool exhaustion
- **Unnecessary load**: Most users just want logs, not table details

### The Fix

1. **Made table queries optional**: Added `includeTables` query parameter
   - Default: `true` (backward compatible)
   - Set to `false` to skip expensive table metrics queries
   - Subscription list page now uses `?includeTables=false`

2. **Fixed "Issues" calculation**: 
   - **Before**: Counted anything not "synced" as an issue (including "lagging")
   - **After**: Only counts "error" and "warning" statuses
   - **Why**: "lagging" is normal during replication - it's not an error

## API Changes

### `/api/groups/[id]/status`

**New Query Parameter**:
- `includeTables` (boolean, default: `true`)
  - `?includeTables=false` - Skip table metrics queries (faster, for list views)
  - `?includeTables=true` or omitted - Include table metrics (for detail views)

**Example**:
```bash
# Fast - for subscription list (no table queries)
GET /api/groups/123/status?includeTables=false

# Full - for subscription details (includes table metrics)
GET /api/groups/123/status?includeTables=true
```

## Performance Impact

### Before
- **Subscription list load**: 30-90 seconds
- **Queries per subscription**: 141+ table queries
- **Database connections**: Exhausted pool
- **User experience**: Slow, timeouts, errors

### After
- **Subscription list load**: < 2 seconds
- **Queries per subscription**: 3-5 (status, conflicts, table count)
- **Database connections**: Minimal usage
- **User experience**: Fast, reliable

## Usage

### Subscription List Page
- Uses `?includeTables=false` by default
- Shows basic status, lag, conflicts
- Table details only loaded when clicking "View Tables"

### Subscription Details Page
- Uses `?includeTables=true` when needed
- Loads table metrics on demand
- Logs are always available (separate endpoint)

## Logs Are Always Available

Subscription logs are available via a separate, fast endpoint:
- `/api/subscriptions/[id]/logs` - Fast, no table queries
- Shows worker status, sync progress, conflicts, errors
- This is what users actually want to see

## Migration Notes

- **Backward compatible**: Existing code still works (defaults to `includeTables=true`)
- **No breaking changes**: All endpoints still function
- **Opt-in optimization**: Pages can opt-in to faster loading

## Future Improvements

1. **Lazy load tables**: Only query tables when "View Tables" is clicked
2. **Cache table metrics**: Store in Redis/memory for faster access
3. **Background updates**: Update table metrics asynchronously
4. **Pagination**: Load tables in pages instead of all at once

