#!/bin/bash

# Quick script to manually trigger rate of change collection
# Useful for testing or immediate data collection

set -e

echo "========================================="
echo "Manual Rate of Change Collection"
echo "========================================="
echo ""

# Check if MONITORING_DB_URL is set
if [ -z "$MONITORING_DB_URL" ]; then
    echo "❌ ERROR: MONITORING_DB_URL environment variable is not set"
    echo ""
    echo "Please set it in your .env.local file or export it:"
    echo "  export MONITORING_DB_URL='postgresql://user:pass@host:port/dbname'"
    exit 1
fi

echo "✓ MONITORING_DB_URL is set"
echo ""

# Load environment variables from .env.local if it exists
if [ -f .env.local ]; then
    echo "Loading environment variables from .env.local..."
    export $(cat .env.local | grep -v '^#' | xargs)
    echo "✓ Environment variables loaded"
    echo ""
fi

# Check if SOURCE_DATABASE_URL is set
if [ -z "$SOURCE_DATABASE_URL" ]; then
    echo "⚠️  WARNING: SOURCE_DATABASE_URL is not set"
    echo "   The collector will try to use subscriptions from the monitoring DB"
    echo ""
fi

echo "Starting rate of change collection..."
echo "This may take a few minutes..."
echo ""
echo "----------------------------------------"

# Run the collector once
ts-node lib/worker/rate-of-change-collector.ts once

echo "----------------------------------------"
echo ""
echo "✓ Collection completed!"
echo ""

# Show results
echo "Latest data collected:"
echo "----------------------------------------"
psql "$MONITORING_DB_URL" -c "
SELECT 
  table_name,
  timestamp,
  source_row_count,
  rate_of_change_1min,
  rate_of_change_10min,
  rate_of_change_1hour
FROM latest_table_rate_of_change
ORDER BY timestamp DESC
LIMIT 10;
"

echo ""
echo "Total snapshots in database:"
ROW_COUNT=$(psql "$MONITORING_DB_URL" -t -c "SELECT COUNT(*) FROM table_rate_of_change;")
echo "$ROW_COUNT snapshots"

echo ""
echo "========================================="
echo "Note: Rates require historical data"
echo "========================================="
echo "- 1-min rate: Available after 1+ minutes"
echo "- 10-min rate: Available after 10+ minutes"
echo "- 1-hour rate: Available after 60+ minutes"
echo ""
echo "Run this script again in a few minutes to see rates populate!"
echo ""
