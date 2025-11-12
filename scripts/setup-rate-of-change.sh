#!/bin/bash

# Setup script for Rate of Change tracking system
# This script will:
# 1. Run the database migration
# 2. Run the collector once to populate initial data
# 3. Provide instructions for setting up cron

set -e

echo "========================================="
echo "Rate of Change Setup Script"
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

# Step 1: Run migration
echo "Step 1: Running database migration..."
echo "----------------------------------------"

if psql "$MONITORING_DB_URL" -f lib/db/migrations/002-add-rate-of-change-table.sql; then
    echo "✓ Migration completed successfully"
else
    echo "⚠️  Migration may have already been applied (this is OK if table exists)"
fi

echo ""

# Step 2: Verify table exists
echo "Step 2: Verifying table creation..."
echo "----------------------------------------"

if psql "$MONITORING_DB_URL" -c "\d table_rate_of_change" > /dev/null 2>&1; then
    echo "✓ Table 'table_rate_of_change' exists"
else
    echo "❌ ERROR: Table 'table_rate_of_change' does not exist"
    exit 1
fi

echo ""

# Step 3: Run collector once
echo "Step 3: Running initial data collection..."
echo "----------------------------------------"
echo "This may take a few minutes depending on the number of tables..."
echo ""

if ts-node lib/worker/rate-of-change-collector.ts once; then
    echo ""
    echo "✓ Initial data collection completed"
else
    echo ""
    echo "⚠️  Data collection had errors (check logs above)"
fi

echo ""

# Step 4: Verify data was collected
echo "Step 4: Verifying data collection..."
echo "----------------------------------------"

ROW_COUNT=$(psql "$MONITORING_DB_URL" -t -c "SELECT COUNT(*) FROM table_rate_of_change;")
echo "Collected data for $ROW_COUNT table snapshots"

if [ "$ROW_COUNT" -gt 0 ]; then
    echo "✓ Data collection successful"
    echo ""
    echo "Sample data:"
    psql "$MONITORING_DB_URL" -c "SELECT table_name, timestamp, source_row_count FROM table_rate_of_change ORDER BY timestamp DESC LIMIT 5;"
else
    echo "⚠️  No data collected yet (this is normal on first run)"
    echo "   Rates will be calculated after the second collection cycle"
fi

echo ""
echo "========================================="
echo "Setup Complete!"
echo "========================================="
echo ""
echo "Next Steps:"
echo ""
echo "1. Set up periodic collection (choose one):"
echo ""
echo "   Option A - Cron Job (Recommended):"
echo "   -----------------------------------"
echo "   Run: crontab -e"
echo "   Add this line for every 10 minutes:"
echo "   */10 * * * * cd $(pwd) && ts-node lib/worker/rate-of-change-collector.ts >> /var/log/rate-of-change.log 2>&1"
echo ""
echo "   Option B - Continuous Process:"
echo "   -------------------------------"
echo "   Run: ts-node lib/worker/rate-of-change-collector.ts continuous 10"
echo ""
echo "2. Wait for data to accumulate:"
echo "   - 1-minute rates: Available after 1 minute"
echo "   - 10-minute rates: Available after 10 minutes"
echo "   - 1-hour rates: Available after 1 hour"
echo "   - 24-hour rates: Available after 24 hours"
echo ""
echo "3. View the data in the dashboard:"
echo "   http://localhost:3002/tables"
echo ""
echo "4. Monitor collection:"
echo "   psql \$MONITORING_DB_URL -c \"SELECT * FROM latest_table_rate_of_change LIMIT 10;\""
echo ""
echo "For more information, see RATE_OF_CHANGE_SETUP.md"
echo ""
