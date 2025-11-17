# Monitoring Replication Progress

This guide explains how to monitor replication progress and track when the target database catches up to the source.

## Quick Start

Monitor a specific table's replication progress:

```bash
./scripts/monitor-replication-progress.sh orders 30
```

This will:
- Show row counts for source and target every 30 seconds
- Display the gap between them
- Show how many rows were replicated since the last check
- Display replication lag in seconds
- Calculate catch-up progress percentage

## Understanding the Output

The script displays:

```
Timestamp            |    Source Rows |    Target Rows |            Gap |         Change |  Lag (s)
--------------------------------------------------------------------------------------------------------
2024-01-15 10:30:00  |       31228521 |       31111511 |        117010 |         +5000 |        5
  → Progress: 5% caught up (5000 of 117010 rows)
```

- **Source Rows**: Current row count in the source database
- **Target Rows**: Current row count in the target database
- **Gap**: Difference (Source - Target)
- **Change**: How many rows were replicated since last check (positive = catching up)
- **Lag (s)**: Replication lag in seconds (time since last transaction was replayed)

## Performance Considerations

The script uses:
- **Exact counts** (`COUNT(*)`) every 5th iteration for accuracy
- **Estimated counts** (`n_live_tup` or `reltuples`) for faster updates in between

This balances accuracy with performance. For very large tables, you may want to:
- Increase the interval (e.g., 60 seconds instead of 30)
- Use only estimates by modifying the script

## Monitoring Multiple Tables

To monitor multiple tables, run the script in separate terminals:

```bash
# Terminal 1
./scripts/monitor-replication-progress.sh orders 30

# Terminal 2
./scripts/monitor-replication-progress.sh trades 30

# Terminal 3
./scripts/monitor-replication-progress.sh positions 30
```

## Integration with Dashboard

The dashboard UI (`/subscriptions/[id]`) also shows:
- Real-time table status with row counts
- Replication logs
- Overall replication status

The monitoring script is useful for:
- Long-running catch-up operations
- Command-line monitoring
- Automated monitoring scripts
- Debugging replication issues

## Expected Behavior

### During Initial Catch-Up

When you first restore a backup and enable replication:
1. **Gap starts large**: Target has fewer rows than source
2. **Gap decreases**: Target catches up as replication processes changes
3. **Gap stabilizes**: Once caught up, gap should be small (< 100 rows typically)

### Normal Operation

Once caught up:
- Gap should remain small (< 1000 rows for active tables)
- Change should be positive (target growing)
- Lag should be low (< 10 seconds typically)

### Troubleshooting

If the gap is **increasing**:
- Replication may be stalled
- Check subscription status: `./scripts/check-replication-lag.sh`
- Check for conflicts or errors in replication logs

If the gap is **not decreasing**:
- Replication may be disabled
- Check subscription: `SELECT * FROM pg_subscription WHERE subenabled = true;`
- Check for errors in the dashboard logs

If **target has more rows than source**:
- This can happen temporarily if:
  - Source had writes that were replicated before being rolled back
  - Estimates are stale (run exact counts to verify)
  - There are writes happening on the target (shouldn't happen in read-only mode)

## Related Scripts

- `check-replication-lag.sh`: Check overall replication lag and subscription status
- `verify-table-row-counts.sql`: Verify exact vs estimated row counts
- `diagnose-target-more-rows.sql`: Diagnose why target might have more rows


