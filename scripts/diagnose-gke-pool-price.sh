#!/bin/bash

# Deep dive into gke-pool-price activity on GCP database

set -e

# Source environment variables
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '^#' | xargs)
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔍 GKE Pool Price Activity Diagnostics"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "1️⃣  Current Connection Status"
echo "─────────────────────────────────────────────────────"
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  usename,
  client_addr,
  state,
  backend_start,
  state_change,
  query_start,
  CASE 
    WHEN query ILIKE 'INSERT%' THEN '✍️  WRITE (INSERT)'
    WHEN query ILIKE 'UPDATE%' THEN '✍️  WRITE (UPDATE)'
    WHEN query ILIKE 'DELETE%' THEN '✍️  WRITE (DELETE)'
    WHEN query ILIKE 'SELECT%' THEN '👀 READ (SELECT)'
    WHEN query ILIKE 'BEGIN%' THEN '🔄 TRANSACTION (BEGIN)'
    WHEN query ILIKE 'COMMIT%' THEN '✅ TRANSACTION (COMMIT)'
    WHEN query ILIKE 'ROLLBACK%' THEN '❌ TRANSACTION (ROLLBACK)'
    ELSE 'OTHER'
  END as current_operation,
  LEFT(query, 150) as query_preview
FROM pg_stat_activity
WHERE application_name = 'gke-pool-price'
  AND datname = current_database()
ORDER BY state_change DESC;
" || echo "⚠️  No active connections found"

echo ""
echo "2️⃣  Connection History (Last 24 Hours)"
echo "─────────────────────────────────────────────────────"
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  usename,
  state,
  state_change,
  NOW() - state_change as time_ago
FROM pg_stat_activity
WHERE application_name = 'gke-pool-price'
  AND datname = current_database()
  AND state_change > NOW() - INTERVAL '24 hours'
ORDER BY state_change DESC
LIMIT 10;
" || echo "⚠️  No recent connections in last 24 hours"

echo ""
echo "3️⃣  Checking pg_stat_statements Extension"
echo "─────────────────────────────────────────────────────"
HAS_PGSS=$(psql "$TARGET_DATABASE_URL" -tAc "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements');")

if [ "$HAS_PGSS" = "t" ]; then
  echo "✅ pg_stat_statements is enabled"
  
  echo ""
  echo "4️⃣  Historical Write Queries (via pg_stat_statements)"
  echo "─────────────────────────────────────────────────────"
  
  # Get the user ID for reya_mainnet_api_rw
  USERID=$(psql "$TARGET_DATABASE_URL" -tAc "SELECT usesysid FROM pg_user WHERE usename = 'reya_mainnet_api_rw';")
  
  if [ -n "$USERID" ]; then
    echo "User ID for reya_mainnet_api_rw: $USERID"
    echo ""
    
    psql "$TARGET_DATABASE_URL" -c "
    SELECT 
      CASE 
        WHEN query ~* '^\\s*INSERT' THEN 'INSERT'
        WHEN query ~* '^\\s*UPDATE' THEN 'UPDATE'
        WHEN query ~* '^\\s*DELETE' THEN 'DELETE'
        ELSE 'OTHER'
      END as operation,
      calls,
      total_exec_time::numeric(10,2) as total_ms,
      mean_exec_time::numeric(10,2) as mean_ms,
      LEFT(query, 120) as query_preview
    FROM pg_stat_statements
    WHERE userid = $USERID
      AND (
        query ~* '^\\s*INSERT'
        OR query ~* '^\\s*UPDATE'
        OR query ~* '^\\s*DELETE'
      )
    ORDER BY calls DESC
    LIMIT 20;
    "
    
    echo ""
    echo "5️⃣  Tables Modified by reya_mainnet_api_rw"
    echo "─────────────────────────────────────────────────────"
    
    psql "$TARGET_DATABASE_URL" -c "
    SELECT 
      CASE 
        WHEN query ~* 'INSERT\\s+INTO\\s+([a-zA-Z_][a-zA-Z0-9_]*)' THEN 
          (regexp_match(query, 'INSERT\\s+INTO\\s+([a-zA-Z_][a-zA-Z0-9_]*)', 'i'))[1]
        WHEN query ~* 'UPDATE\\s+([a-zA-Z_][a-zA-Z0-9_]*)' THEN 
          (regexp_match(query, 'UPDATE\\s+([a-zA-Z_][a-zA-Z0-9_]*)', 'i'))[1]
        WHEN query ~* 'DELETE\\s+FROM\\s+([a-zA-Z_][a-zA-Z0-9_]*)' THEN 
          (regexp_match(query, 'DELETE\\s+FROM\\s+([a-zA-Z_][a-zA-Z0-9_]*)', 'i'))[1]
      END as table_name,
      CASE 
        WHEN query ~* '^\\s*INSERT' THEN 'INSERT'
        WHEN query ~* '^\\s*UPDATE' THEN 'UPDATE'
        WHEN query ~* '^\\s*DELETE' THEN 'DELETE'
      END as operation,
      calls,
      total_exec_time::numeric(10,2) as total_ms
    FROM pg_stat_statements
    WHERE userid = $USERID
      AND (
        query ~* '^\\s*INSERT'
        OR query ~* '^\\s*UPDATE'
        OR query ~* '^\\s*DELETE'
      )
    ORDER BY calls DESC
    LIMIT 30;
    " | grep -v "^\$" | head -50
  else
    echo "⚠️  Could not find user ID for reya_mainnet_api_rw"
  fi
  
else
  echo "❌ pg_stat_statements is NOT enabled"
  echo "   Historical query tracking is unavailable."
  echo "   Only real-time pg_stat_activity data is available."
fi

echo ""
echo "6️⃣  All Queries from reya_mainnet_api_rw User (Last 24h)"
echo "─────────────────────────────────────────────────────"
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  CASE 
    WHEN query ILIKE 'INSERT%' THEN 'INSERT'
    WHEN query ILIKE 'UPDATE%' THEN 'UPDATE'
    WHEN query ILIKE 'DELETE%' THEN 'DELETE'
    WHEN query ILIKE 'SELECT%' THEN 'SELECT'
    ELSE 'OTHER'
  END as query_type,
  state,
  state_change,
  LEFT(query, 100) as query_preview
FROM pg_stat_activity
WHERE usename = 'reya_mainnet_api_rw'
  AND datname = current_database()
  AND state_change > NOW() - INTERVAL '24 hours'
ORDER BY state_change DESC
LIMIT 20;
"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Diagnostics Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
