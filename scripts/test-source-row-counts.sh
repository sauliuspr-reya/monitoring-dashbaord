#!/bin/bash

# Test source database row count queries
# Usage: ./scripts/test-source-row-counts.sh

set -e

echo "🔍 Testing Source Database Row Count Queries"
echo "=========================================="
echo ""

# Load environment variables
if [ -f .env.local ]; then
  source .env.local
else
  echo "❌ Error: .env.local not found"
  exit 1
fi

# Parse source database connection
SOURCE_DB_URL="${SOURCE_DATABASE_URL}"
SOURCE_DB_HOST=$(echo "$SOURCE_DB_URL" | sed 's/.*@\([^:]*\):.*/\1/')
SOURCE_DB_PORT=$(echo "$SOURCE_DB_URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
SOURCE_DB_NAME=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\([^?]*\).*/\1/')
SOURCE_DB_USER=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\/\([^:]*\):.*/\1/')
SOURCE_DB_PASSWORD=$(echo "$SOURCE_DB_URL" | sed 's/.*\/\/[^:]*:\([^@]*\)@.*/\1/' | sed 's/%24/$/g' | sed 's/%3D/=/g')

echo "📊 Source Database: $SOURCE_DB_HOST:$SOURCE_DB_PORT/$SOURCE_DB_NAME"
echo ""

# Test connection
echo "1️⃣ Testing connection..."
if PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
  echo "   ✅ Connected successfully"
else
  echo "   ❌ Connection failed!"
  exit 1
fi

echo ""
echo "2️⃣ Testing large table row counts (from pub_app_core_large)..."
echo ""

# Test BridgeTransactionsMarginAccount
echo "Testing: BridgeTransactionsMarginAccount"
echo "----------------------------------------"
echo -n "COUNT(*) query (may take time): "
START_TIME=$(date +%s)

RESULT=$(PGPASSWORD="$SOURCE_DB_PASSWORD" timeout 10 psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "SELECT COUNT(*) FROM public.\"BridgeTransactionsMarginAccount\"" 2>&1)
EXIT_CODE=$?
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ $RESULT rows (${DURATION}s)"
elif [ $EXIT_CODE -eq 124 ]; then
  echo "⏱️  TIMEOUT after 10 seconds"
  echo "   This is why source shows 0 in dashboard!"
else
  echo "❌ ERROR: $RESULT"
fi

# Test using estimate instead
echo -n "Estimate (pg_class.reltuples): "
ESTIMATE=$(PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "SELECT reltuples::bigint FROM pg_class WHERE relname = 'BridgeTransactionsMarginAccount' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')" 2>&1)
if [ $? -eq 0 ]; then
  echo "✅ ~$ESTIMATE rows (instant)"
else
  echo "❌ ERROR: $ESTIMATE"
fi

echo ""

# Test BridgeTransactionsPool
echo "Testing: BridgeTransactionsPool"
echo "----------------------------------------"
echo -n "COUNT(*) query (may take time): "
START_TIME=$(date +%s)

RESULT=$(PGPASSWORD="$SOURCE_DB_PASSWORD" timeout 10 psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "SELECT COUNT(*) FROM public.\"BridgeTransactionsPool\"" 2>&1)
EXIT_CODE=$?
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ $RESULT rows (${DURATION}s)"
elif [ $EXIT_CODE -eq 124 ]; then
  echo "⏱️  TIMEOUT after 10 seconds"
  echo "   This is why source shows 0 in dashboard!"
else
  echo "❌ ERROR: $RESULT"
fi

echo -n "Estimate (pg_class.reltuples): "
ESTIMATE=$(PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "SELECT reltuples::bigint FROM pg_class WHERE relname = 'BridgeTransactionsPool' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')" 2>&1)
if [ $? -eq 0 ]; then
  echo "✅ ~$ESTIMATE rows (instant)"
else
  echo "❌ ERROR: $ESTIMATE"
fi

echo ""

# Test ConditionalOrders
echo "Testing: ConditionalOrders"
echo "----------------------------------------"
echo -n "COUNT(*) query (may take time): "
START_TIME=$(date +%s)

RESULT=$(PGPASSWORD="$SOURCE_DB_PASSWORD" timeout 10 psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "SELECT COUNT(*) FROM public.\"ConditionalOrders\"" 2>&1)
EXIT_CODE=$?
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ $RESULT rows (${DURATION}s)"
elif [ $EXIT_CODE -eq 124 ]; then
  echo "⏱️  TIMEOUT after 10 seconds"
  echo "   This is why source shows 0 in dashboard!"
else
  echo "❌ ERROR: $RESULT"
fi

echo -n "Estimate (pg_class.reltuples): "
ESTIMATE=$(PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "SELECT reltuples::bigint FROM pg_class WHERE relname = 'ConditionalOrders' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')" 2>&1)
if [ $? -eq 0 ]; then
  echo "✅ ~$ESTIMATE rows (instant)"
else
  echo "❌ ERROR: $ESTIMATE"
fi

echo ""
echo "=========================================="
echo "📋 Summary & Diagnosis"
echo "=========================================="
echo ""
echo "ISSUE: Dashboard shows Source Rows = 0"
echo ""
echo "ROOT CAUSE:"
echo "  The API tries COUNT(*) on large source tables, which either:"
echo "  1. Times out (takes > 10 seconds)"
echo "  2. Is too slow for real-time dashboard"
echo "  3. Locks the table briefly, impacting production"
echo ""
echo "SOLUTION:"
echo "  Use pg_class.reltuples for estimates instead of COUNT(*)"
echo "  - Instant results (no table scan)"
echo "  - Approximate but good enough for monitoring"
echo "  - No impact on production performance"
echo ""
echo "  The API already has this logic (line 90-95) but might not be"
echo "  triggering correctly. Need to verify estimate threshold."
echo ""
echo "RECOMMENDATION:"
echo "  1. Always use estimates for monitoring (pg_class.reltuples)"
echo "  2. Use exact counts only for final verification/audit"
echo "  3. Cache row counts to avoid repeated queries"
echo ""
