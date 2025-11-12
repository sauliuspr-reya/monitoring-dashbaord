#!/bin/bash

# Analyze transaction patterns and context for gke-pool-price

set -e

# Source environment variables
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '^#' | xargs)
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔬 Transaction Context Analysis"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "1️⃣  Active Transactions with Context"
echo "─────────────────────────────────────────────────────"
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  usename,
  state,
  backend_xid,
  backend_xmin,
  xact_start,
  query_start,
  state_change,
  NOW() - xact_start as txn_duration,
  NOW() - query_start as query_duration,
  CASE 
    WHEN query ILIKE 'SET%' THEN 'SET: ' || SUBSTRING(query FROM 'SET\\s+(\\S+)' FOR 50)
    WHEN query ILIKE 'BEGIN%' THEN 'BEGIN'
    WHEN query ILIKE 'COMMIT%' THEN 'COMMIT'
    WHEN query ILIKE 'ROLLBACK%' THEN 'ROLLBACK'
    WHEN query ILIKE 'INSERT%' THEN 'INSERT INTO ' || SUBSTRING(query FROM 'INSERT\\s+INTO\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?' FOR 50)
    WHEN query ILIKE 'UPDATE%' THEN 'UPDATE ' || SUBSTRING(query FROM 'UPDATE\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?' FOR 50)
    WHEN query ILIKE 'DELETE%' THEN 'DELETE FROM ' || SUBSTRING(query FROM 'DELETE\\s+FROM\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?' FOR 50)
    ELSE LEFT(query, 60)
  END as operation,
  wait_event_type,
  wait_event
FROM pg_stat_activity
WHERE application_name = 'gke-pool-price'
  AND datname = current_database()
  AND state != 'idle'
ORDER BY xact_start DESC NULLS LAST;
" || echo "⚠️  No active transactions"

echo ""
echo "2️⃣  Recent Transaction Patterns (Last Hour)"
echo "─────────────────────────────────────────────────────"
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  state,
  COUNT(*) as occurrences,
  MIN(state_change) as first_seen,
  MAX(state_change) as last_seen,
  MAX(state_change) - MIN(state_change) as time_span
FROM pg_stat_activity
WHERE application_name = 'gke-pool-price'
  AND datname = current_database()
  AND state_change > NOW() - INTERVAL '1 hour'
GROUP BY application_name, state
ORDER BY last_seen DESC;
"

echo ""
echo "3️⃣  SET Commands Analysis (What Configuration Changes)"
echo "─────────────────────────────────────────────────────"
echo "Checking pg_stat_statements for SET patterns..."

HAS_PGSS=$(psql "$TARGET_DATABASE_URL" -tAc "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements');")

if [ "$HAS_PGSS" = "t" ]; then
  USERID=$(psql "$TARGET_DATABASE_URL" -tAc "SELECT usesysid FROM pg_user WHERE usename = 'reya_mainnet_api_rw';")
  
  if [ -n "$USERID" ]; then
    psql "$TARGET_DATABASE_URL" -c "
    SELECT 
      calls,
      CASE 
        WHEN query ~* 'SET\\s+search_path' THEN 'search_path'
        WHEN query ~* 'SET\\s+transaction' THEN 'transaction isolation'
        WHEN query ~* 'SET\\s+time\\s*zone' THEN 'timezone'
        WHEN query ~* 'SET\\s+statement_timeout' THEN 'statement_timeout'
        WHEN query ~* 'SET\\s+lock_timeout' THEN 'lock_timeout'
        WHEN query ~* 'SET\\s+application_name' THEN 'application_name'
        ELSE 'other'
      END as set_type,
      LEFT(query, 100) as set_command
    FROM pg_stat_statements
    WHERE userid = $USERID
      AND query ~* '^\\s*SET'
    ORDER BY calls DESC
    LIMIT 20;
    "
  fi
else
  echo "❌ pg_stat_statements not available"
fi

echo ""
echo "4️⃣  Query Sequence Analysis (Before COMMIT)"
echo "─────────────────────────────────────────────────────"
echo "Looking for write patterns in pg_stat_statements..."

if [ "$HAS_PGSS" = "t" ] && [ -n "$USERID" ]; then
  psql "$TARGET_DATABASE_URL" -c "
  WITH write_queries AS (
    SELECT 
      CASE 
        WHEN query ~* 'INSERT\\s+INTO\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?' THEN 
          regexp_replace(query, '.*INSERT\\s+INTO\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?.*', '\\1', 'i')
        WHEN query ~* 'UPDATE\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?' THEN 
          regexp_replace(query, '.*UPDATE\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?.*', '\\1', 'i')
        WHEN query ~* 'DELETE\\s+FROM\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?' THEN 
          regexp_replace(query, '.*DELETE\\s+FROM\\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?.*', '\\1', 'i')
      END as table_name,
      CASE 
        WHEN query ~* '^\\s*INSERT' THEN 'INSERT'
        WHEN query ~* '^\\s*UPDATE' THEN 'UPDATE'
        WHEN query ~* '^\\s*DELETE' THEN 'DELETE'
      END as operation,
      calls,
      total_exec_time::numeric(10,2) as total_ms,
      mean_exec_time::numeric(10,2) as mean_ms,
      (total_exec_time / calls)::numeric(10,2) as avg_ms_per_call
    FROM pg_stat_statements
    WHERE userid = $USERID
      AND (
        query ~* '^\\s*INSERT'
        OR query ~* '^\\s*UPDATE'
        OR query ~* '^\\s*DELETE'
      )
  )
  SELECT 
    table_name,
    operation,
    calls,
    total_ms,
    avg_ms_per_call,
    (calls * 1.0 / NULLIF((SELECT SUM(calls) FROM write_queries), 0) * 100)::numeric(5,2) as pct_of_writes
  FROM write_queries
  WHERE table_name IS NOT NULL
  ORDER BY calls DESC
  LIMIT 30;
  "
  
  echo ""
  echo "5️⃣  Transaction Overhead Analysis"
  echo "─────────────────────────────────────────────────────"
  
  psql "$TARGET_DATABASE_URL" -c "
  SELECT 
    CASE 
      WHEN query ~* '^\\s*BEGIN' THEN 'BEGIN'
      WHEN query ~* '^\\s*COMMIT' THEN 'COMMIT'
      WHEN query ~* '^\\s*ROLLBACK' THEN 'ROLLBACK'
      WHEN query ~* '^\\s*SET' THEN 'SET'
      WHEN query ~* '^\\s*INSERT' THEN 'INSERT'
      WHEN query ~* '^\\s*UPDATE' THEN 'UPDATE'
      WHEN query ~* '^\\s*DELETE' THEN 'DELETE'
      WHEN query ~* '^\\s*SELECT' THEN 'SELECT'
      ELSE 'OTHER'
    END as query_type,
    calls,
    total_exec_time::numeric(10,2) as total_ms,
    mean_exec_time::numeric(10,2) as mean_ms,
    (total_exec_time / NULLIF((SELECT SUM(total_exec_time) FROM pg_stat_statements WHERE userid = $USERID), 0) * 100)::numeric(5,2) as pct_of_time
  FROM pg_stat_statements
  WHERE userid = $USERID
  GROUP BY query_type, calls, total_exec_time, mean_exec_time
  ORDER BY total_exec_time DESC
  LIMIT 20;
  "
fi

echo ""
echo "6️⃣  Connection Pool Behavior"
echo "─────────────────────────────────────────────────────"
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  COUNT(DISTINCT pid) as unique_connections,
  COUNT(*) as total_snapshots,
  MIN(backend_start) as oldest_connection,
  MAX(backend_start) as newest_connection,
  MAX(backend_start) - MIN(backend_start) as connection_age_span
FROM pg_stat_activity
WHERE application_name = 'gke-pool-price'
  AND datname = current_database()
GROUP BY application_name;
"

echo ""
echo "7️⃣  Recent Write Activity by Table (Correlated)"
echo "─────────────────────────────────────────────────────"
echo "Checking for writes that happened near COMMIT times..."

psql "$TARGET_DATABASE_URL" -c "
WITH recent_activity AS (
  SELECT 
    application_name,
    state,
    query,
    state_change,
    LEAD(state) OVER (PARTITION BY application_name ORDER BY state_change) as next_state,
    LEAD(query) OVER (PARTITION BY application_name ORDER BY state_change) as next_query
  FROM pg_stat_activity
  WHERE application_name = 'gke-pool-price'
    AND datname = current_database()
    AND state_change > NOW() - INTERVAL '2 hours'
)
SELECT 
  state_change,
  CASE 
    WHEN query ILIKE 'INSERT%' THEN 'WRITE: INSERT'
    WHEN query ILIKE 'UPDATE%' THEN 'WRITE: UPDATE'
    WHEN query ILIKE 'DELETE%' THEN 'WRITE: DELETE'
    WHEN query ILIKE 'COMMIT%' THEN 'TXN: COMMIT'
    WHEN query ILIKE 'BEGIN%' THEN 'TXN: BEGIN'
    WHEN query ILIKE 'SET%' THEN 'CONFIG: SET'
    ELSE 'OTHER'
  END as current_op,
  CASE 
    WHEN next_query ILIKE 'COMMIT%' THEN 'TXN: COMMIT'
    WHEN next_query ILIKE 'BEGIN%' THEN 'TXN: BEGIN'
    ELSE 'OTHER'
  END as next_op,
  LEFT(query, 80) as query_preview
FROM recent_activity
WHERE query IS NOT NULL
ORDER BY state_change DESC
LIMIT 30;
"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Transaction Analysis Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Key Insights:"
echo "   - SET commands configure session parameters"
echo "   - COMMIT commands end transactions containing writes"
echo "   - Check pg_stat_statements for the actual write patterns"
echo "   - The application likely uses connection pooling"
