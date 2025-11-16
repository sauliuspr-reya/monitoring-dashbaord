#!/bin/bash
set -euo pipefail

# Script to diagnose timeout issues with Cloud SQL
# This helps identify if the issue is connection pool exhaustion, too many concurrent queries, etc.

echo "========================================="
echo "Cloud SQL Timeout Diagnostics"
echo "========================================="
echo ""

# Check if we can connect to the databases
if [[ -z "${SOURCE_DATABASE_URL:-}" ]] || [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
    echo "⚠️  SOURCE_DATABASE_URL or TARGET_DATABASE_URL not set"
    echo "   Loading from .env.local if available..."
    if [ -f .env.local ]; then
        set -a
        source .env.local
        set +a
    else
        echo "❌ Cannot proceed without database URLs"
        exit 1
    fi
fi

parse_db_url() {
    local url=$1
    python3 -c "
from urllib.parse import urlparse, unquote
url = urlparse('$url')
print(f\"{url.hostname}|{url.port or 5432}|{unquote(url.username or '')}|{unquote(url.password or '')}|{url.path.lstrip('/')}\")
"
}

TARGET_INFO=$(parse_db_url "$TARGET_DATABASE_URL")
IFS='|' read -r TARGET_HOST TARGET_PORT TARGET_USER TARGET_PASS TARGET_DB <<< "$TARGET_INFO"

echo "Testing connection to GCP Cloud SQL (Target):"
echo "  Host: $TARGET_HOST"
echo "  Port: $TARGET_PORT"
echo "  Database: $TARGET_DB"
echo ""

# Test basic connectivity
echo "1. Testing basic connectivity..."
if PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -c "SELECT 1;" &>/dev/null; then
    echo "   ✓ Connection successful"
else
    echo "   ❌ Connection failed"
    exit 1
fi

echo ""
echo "2. Checking current connection count..."
CONN_COUNT=$(PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -A -c "
SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database();
" 2>/dev/null || echo "0")

echo "   Current active connections: $CONN_COUNT"

MAX_CONN=$(PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -A -c "
SELECT setting FROM pg_settings WHERE name = 'max_connections';
" 2>/dev/null || echo "unknown")

echo "   Max connections: $MAX_CONN"

if [[ "$CONN_COUNT" != "0" ]] && [[ "$MAX_CONN" != "unknown" ]]; then
    CONN_PERCENT=$((CONN_COUNT * 100 / MAX_CONN))
    echo "   Connection usage: ${CONN_PERCENT}%"
    if [[ $CONN_PERCENT -gt 80 ]]; then
        echo "   ⚠️  WARNING: High connection usage!"
    fi
fi

echo ""
echo "3. Checking for long-running queries..."
LONG_QUERIES=$(PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -A -c "
SELECT COUNT(*) 
FROM pg_stat_activity 
WHERE datname = current_database()
  AND state = 'active'
  AND query_start < NOW() - INTERVAL '10 seconds';
" 2>/dev/null || echo "0")

echo "   Queries running > 10 seconds: $LONG_QUERIES"
if [[ "$LONG_QUERIES" != "0" ]]; then
    echo "   ⚠️  WARNING: Long-running queries detected"
    echo ""
    echo "   Long-running query details:"
    PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -c "
    SELECT 
        pid,
        application_name,
        state,
        EXTRACT(EPOCH FROM (NOW() - query_start))::int as duration_seconds,
        LEFT(query, 100) as query_preview
    FROM pg_stat_activity 
    WHERE datname = current_database()
      AND state = 'active'
      AND query_start < NOW() - INTERVAL '10 seconds'
    ORDER BY query_start
    LIMIT 10;
    " 2>/dev/null || echo "   (Could not retrieve details)"
fi

echo ""
echo "4. Checking Cloud SQL instance configuration..."
echo "   (This requires gcloud CLI and appropriate permissions)"
if command -v gcloud &> /dev/null; then
    # Try to get instance info (this might fail if not authenticated or wrong project)
    INSTANCE_NAME=$(echo "$TARGET_HOST" | cut -d'.' -f1)
    echo "   Attempting to get instance info for: $INSTANCE_NAME"
    gcloud sql instances describe "$INSTANCE_NAME" --format="value(settings.tier,settings.databaseFlags)" 2>/dev/null || echo "   (Could not retrieve instance info - check gcloud auth)"
else
    echo "   gcloud CLI not found - skipping instance info"
fi

echo ""
echo "5. Testing query performance..."
echo "   Running simple SELECT query..."
START_TIME=$(date +%s)
PGPASSWORD="$TARGET_PASS" psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';" &>/dev/null
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
echo "   Query duration: ${DURATION}s"
if [[ $DURATION -gt 5 ]]; then
    echo "   ⚠️  WARNING: Slow query response time"
fi

echo ""
echo "6. Recommendations:"
echo ""
if [[ "$CONN_COUNT" != "0" ]] && [[ "$MAX_CONN" != "unknown" ]]; then
    CONN_PERCENT=$((CONN_COUNT * 100 / MAX_CONN))
    if [[ $CONN_PERCENT -gt 80 ]]; then
        echo "   • Connection pool is nearly exhausted"
        echo "     - Reduce max connections in application pools"
        echo "     - Process queries in batches instead of parallel"
        echo "     - Consider upgrading Cloud SQL instance tier"
    fi
fi

if [[ "$LONG_QUERIES" != "0" ]]; then
    echo "   • Long-running queries detected"
    echo "     - Check for missing indexes"
    echo "     - Optimize COUNT(*) queries (use estimates for large tables)"
    echo "     - Add query timeouts"
fi

if [[ $DURATION -gt 5 ]]; then
    echo "   • Slow query performance"
    echo "     - Check network latency between pods and Cloud SQL"
    echo "     - Verify Cloud SQL instance is not under-provisioned"
    echo "     - Check for connection pooling issues"
fi

echo ""
echo "========================================="
echo "Common Cloud SQL Performance Issues:"
echo "========================================="
echo ""
echo "1. TOO MANY CONCURRENT QUERIES:"
echo "   - Your code runs queries for ALL tables in parallel"
echo "   - For 141 tables, that's 141+ concurrent queries"
echo "   - Solution: Process tables in batches of 5-10"
echo ""
echo "2. CONNECTION POOL EXHAUSTION:"
echo "   - Each API call creates new connection pools"
echo "   - Pools are not reused between requests"
echo "   - Solution: Implement connection pool caching/reuse"
echo ""
echo "3. SLOW COUNT(*) QUERIES:"
echo "   - COUNT(*) on large tables is very slow"
echo "   - Solution: Use pg_class.reltuples for estimates"
echo ""
echo "4. NETWORK LATENCY:"
echo "   - Pods in different regions than Cloud SQL"
echo "   - Solution: Use Cloud SQL Proxy or ensure same region"
echo ""
echo "5. UNDER-PROVISIONED INSTANCE:"
echo "   - New Cloud SQL instances may be small/shared-core"
echo "   - Solution: Upgrade to dedicated CPU, more memory"
echo ""
echo "========================================="

