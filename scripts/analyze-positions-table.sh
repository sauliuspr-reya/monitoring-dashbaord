#!/bin/bash

# Analyze writers to the positions table on both AWS and GCP

set -e

# Source environment variables
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '^#' | xargs)
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📊 Positions Table Write Analysis"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "🔵 SOURCE DATABASE (AWS)"
echo "─────────────────────────────────────────────────────"

echo ""
echo "1️⃣  Active Writers to 'positions' (pg_stat_activity)"
echo "─────────────────────────────────────────────────────"
psql "$SOURCE_DATABASE_URL" -c "
SELECT 
  application_name,
  usename,
  client_addr,
  state,
  state_change,
  NOW() - state_change as time_ago,
  CASE 
    WHEN query ~* 'INSERT.*positions' THEN 'INSERT'
    WHEN query ~* 'UPDATE.*positions' THEN 'UPDATE'
    WHEN query ~* 'DELETE.*positions' THEN 'DELETE'
    ELSE 'OTHER'
  END as operation,
  LEFT(query, 120) as query_preview
FROM pg_stat_activity
WHERE datname = current_database()
  AND (
    query ~* 'INSERT.*INTO.*positions'
    OR query ~* 'UPDATE.*positions'
    OR query ~* 'DELETE.*FROM.*positions'
  )
  AND state_change > NOW() - INTERVAL '24 hours'
ORDER BY state_change DESC
LIMIT 20;
" 2>&1 | grep -v "^$" || echo "  No active writers found in last 24 hours"

echo ""
echo "2️⃣  Historical Writers via pg_stat_statements (AWS)"
echo "─────────────────────────────────────────────────────"

HAS_PGSS_SOURCE=$(psql "$SOURCE_DATABASE_URL" -tAc "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements');" 2>/dev/null || echo "f")

if [ "$HAS_PGSS_SOURCE" = "t" ]; then
  echo "✅ pg_stat_statements enabled on source"
  echo ""
  
  psql "$SOURCE_DATABASE_URL" -c "
  SELECT 
    CASE 
      WHEN query ~* 'INSERT.*INTO.*positions' THEN 'INSERT'
      WHEN query ~* 'UPDATE.*positions' THEN 'UPDATE'
      WHEN query ~* 'DELETE.*FROM.*positions' THEN 'DELETE'
    END as operation,
    calls,
    total_exec_time::numeric(10,2) as total_ms,
    mean_exec_time::numeric(10,2) as mean_ms,
    LEFT(query, 100) as query_preview
  FROM pg_stat_statements
  WHERE (
    query ~* 'INSERT.*INTO.*positions'
    OR query ~* 'UPDATE.*positions'
    OR query ~* 'DELETE.*FROM.*positions'
  )
  ORDER BY calls DESC
  LIMIT 20;
  "
  
  echo ""
  echo "3️⃣  Applications Writing to positions (by username correlation)"
  echo "─────────────────────────────────────────────────────"
  
  psql "$SOURCE_DATABASE_URL" -c "
  SELECT DISTINCT
    psa.application_name,
    psa.usename,
    COUNT(*) as connection_count,
    MAX(psa.state_change) as last_activity
  FROM pg_stat_activity psa
  WHERE psa.datname = current_database()
    AND psa.application_name IS NOT NULL
    AND psa.application_name != ''
    AND (
      psa.query ~* 'positions'
      OR EXISTS (
        SELECT 1 FROM pg_stat_statements pss
        WHERE pss.userid = psa.usesysid
          AND pss.query ~* 'positions'
      )
    )
    AND psa.state_change > NOW() - INTERVAL '24 hours'
  GROUP BY psa.application_name, psa.usename
  ORDER BY last_activity DESC;
  "
else
  echo "❌ pg_stat_statements not enabled on source"
  echo "   Only real-time activity data available"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🟢 TARGET DATABASE (GCP)"
echo "─────────────────────────────────────────────────────"

echo ""
echo "1️⃣  Active Writers to 'positions' (pg_stat_activity)"
echo "─────────────────────────────────────────────────────"
psql "$TARGET_DATABASE_URL" -c "
SELECT 
  application_name,
  usename,
  client_addr,
  state,
  state_change,
  NOW() - state_change as time_ago,
  CASE 
    WHEN query ~* 'INSERT.*positions' THEN 'INSERT'
    WHEN query ~* 'UPDATE.*positions' THEN 'UPDATE'
    WHEN query ~* 'DELETE.*positions' THEN 'DELETE'
    ELSE 'OTHER'
  END as operation,
  LEFT(query, 120) as query_preview
FROM pg_stat_activity
WHERE datname = current_database()
  AND (
    query ~* 'INSERT.*INTO.*positions'
    OR query ~* 'UPDATE.*positions'
    OR query ~* 'DELETE.*FROM.*positions'
  )
  AND state_change > NOW() - INTERVAL '24 hours'
ORDER BY state_change DESC
LIMIT 20;
" 2>&1 | grep -v "^$" || echo "  No active writers found in last 24 hours"

echo ""
echo "2️⃣  Historical Writers via pg_stat_statements (GCP)"
echo "─────────────────────────────────────────────────────"

HAS_PGSS_TARGET=$(psql "$TARGET_DATABASE_URL" -tAc "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements');" 2>/dev/null || echo "f")

if [ "$HAS_PGSS_TARGET" = "t" ]; then
  echo "✅ pg_stat_statements enabled on target"
  echo ""
  
  psql "$TARGET_DATABASE_URL" -c "
  SELECT 
    CASE 
      WHEN query ~* 'INSERT.*INTO.*\"?positions\"?' THEN 'INSERT'
      WHEN query ~* 'UPDATE.*\"?positions\"?' THEN 'UPDATE'
      WHEN query ~* 'DELETE.*FROM.*\"?positions\"?' THEN 'DELETE'
    END as operation,
    calls,
    total_exec_time::numeric(10,2) as total_ms,
    mean_exec_time::numeric(10,2) as mean_ms,
    LEFT(query, 100) as query_preview
  FROM pg_stat_statements
  WHERE (
    query ~* 'INSERT.*INTO.*\"?positions\"?'
    OR query ~* 'UPDATE.*\"?positions\"?'
    OR query ~* 'DELETE.*FROM.*\"?positions\"?'
  )
  ORDER BY calls DESC
  LIMIT 20;
  "
  
  echo ""
  echo "3️⃣  Applications Writing to positions (by username correlation)"
  echo "─────────────────────────────────────────────────────"
  
  psql "$TARGET_DATABASE_URL" -c "
  WITH position_writers AS (
    SELECT DISTINCT
      userid,
      query
    FROM pg_stat_statements
    WHERE (
      query ~* 'INSERT.*INTO.*\"?positions\"?'
      OR query ~* 'UPDATE.*\"?positions\"?'
      OR query ~* 'DELETE.*FROM.*\"?positions\"?'
    )
  )
  SELECT DISTINCT
    psa.application_name,
    psa.usename,
    COUNT(*) OVER (PARTITION BY psa.application_name) as connection_count,
    MAX(psa.state_change) OVER (PARTITION BY psa.application_name) as last_activity
  FROM pg_stat_activity psa
  WHERE psa.datname = current_database()
    AND psa.application_name IS NOT NULL
    AND psa.application_name != ''
    AND EXISTS (
      SELECT 1 FROM position_writers pw
      WHERE pw.userid = psa.usesysid
    )
  ORDER BY last_activity DESC
  LIMIT 20;
  "
else
  echo "❌ pg_stat_statements not enabled on target"
  echo "   Only real-time activity data available"
fi

echo ""
echo "4️⃣  Row Count Comparison"
echo "─────────────────────────────────────────────────────"
echo "Source (AWS) positions count:"
SOURCE_COUNT=$(psql "$SOURCE_DATABASE_URL" -tAc "SELECT COUNT(*) FROM positions;")
echo "  $SOURCE_COUNT rows"

echo ""
echo "Target (GCP) positions count:"
TARGET_COUNT=$(psql "$TARGET_DATABASE_URL" -tAc "SELECT COUNT(*) FROM positions;")
echo "  $TARGET_COUNT rows"

echo ""
GAP=$((SOURCE_COUNT - TARGET_COUNT))
if [ $GAP -gt 0 ]; then
  echo "⚠️  Gap: $GAP rows (Target is behind)"
elif [ $GAP -lt 0 ]; then
  echo "⚠️  Gap: $((GAP * -1)) rows (Target has MORE rows - potential dual writes!)"
else
  echo "✅ In sync"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Analysis Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
