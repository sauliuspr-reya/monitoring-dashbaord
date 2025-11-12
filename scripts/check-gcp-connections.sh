#!/bin/bash

# Check all connections to GCP database, including readers

set -e

# Source environment variables
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '^#' | xargs)
fi

echo "=== All Active Connections on GCP Database ==="
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  usename,
  client_addr,
  state,
  CASE 
    WHEN query ILIKE 'INSERT%' THEN 'INSERT'
    WHEN query ILIKE 'UPDATE%' THEN 'UPDATE'
    WHEN query ILIKE 'DELETE%' THEN 'DELETE'
    WHEN query ILIKE 'SELECT%' THEN 'SELECT'
    ELSE 'OTHER'
  END as query_type,
  state_change
FROM pg_stat_activity
WHERE application_name IS NOT NULL
  AND application_name != ''
  AND datname = current_database()
  AND pid != pg_backend_pid()
ORDER BY application_name, state_change DESC;
"

echo ""
echo "=== Filtering for 'pool' or 'price' in application name ==="
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  usename,
  state,
  CASE 
    WHEN query ILIKE 'INSERT%' THEN 'WRITE (INSERT)'
    WHEN query ILIKE 'UPDATE%' THEN 'WRITE (UPDATE)'
    WHEN query ILIKE 'DELETE%' THEN 'WRITE (DELETE)'
    WHEN query ILIKE 'SELECT%' THEN 'READ (SELECT)'
    ELSE 'OTHER'
  END as operation,
  LEFT(query, 100) as query_preview
FROM pg_stat_activity
WHERE (application_name ILIKE '%pool%' OR application_name ILIKE '%price%')
  AND datname = current_database()
  AND pid != pg_backend_pid()
ORDER BY application_name;
"

echo ""
echo "=== Checking for pg_stat_statements (historical query data) ==="
HAS_PGSS=$(psql "$TARGET_DATABASE_URL" -tAc "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements');")

if [ "$HAS_PGSS" = "t" ]; then
  echo "✓ pg_stat_statements is available"
  echo ""
  echo "=== Historical write queries from gke-pool-price ==="
  psql "$TARGET_DATABASE_URL" -c "
  SELECT 
    LEFT(query, 100) as query_preview,
    calls,
    total_exec_time::numeric(10,2) as total_ms,
    mean_exec_time::numeric(10,2) as mean_ms
  FROM pg_stat_statements
  WHERE query ILIKE '%pool%price%'
     OR query SIMILAR TO '%(INSERT|UPDATE|DELETE)%'
  ORDER BY calls DESC
  LIMIT 20;
  "
else
  echo "✗ pg_stat_statements is not enabled (cannot show historical queries)"
fi
