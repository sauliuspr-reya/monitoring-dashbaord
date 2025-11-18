#!/bin/bash

# Test Environment Setup for Verification System
# Creates source, target, and monitoring databases with test data

set -e

echo "========================================="
echo "Setting up Test Environment"
echo "========================================="
echo ""

# PostgreSQL connection details (from docker-compose.yml)
PG_HOST="localhost"
PG_PORT="5432"
PG_USER="postgres"
PG_PASSWORD="postgres"

# Database names
SOURCE_DB="source_test"
TARGET_DB="target_test"
MONITORING_DB="monitoring_test"

# Test parameters
TOTAL_ROWS=10000
MISSING_ROWS_PERCENT=5    # 5% = 500 rows
MISMATCH_ROWS_PERCENT=10  # 10% = 1000 rows

echo "Configuration:"
echo "  Host: $PG_HOST:$PG_PORT"
echo "  User: $PG_USER"
echo "  Source DB: $SOURCE_DB"
echo "  Target DB: $TARGET_DB"
echo "  Monitoring DB: $MONITORING_DB"
echo "  Total rows: $TOTAL_ROWS"
echo "  Missing rows: ${MISSING_ROWS_PERCENT}% ($(($TOTAL_ROWS * $MISSING_ROWS_PERCENT / 100)))"
echo "  Mismatched rows: ${MISMATCH_ROWS_PERCENT}% ($(($TOTAL_ROWS * $MISMATCH_ROWS_PERCENT / 100)))"
echo ""

# Function to execute SQL
execute_sql() {
  local db=$1
  local sql=$2
  PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $db -c "$sql" -q
}

# Step 1: Create databases
echo "Step 1: Creating databases..."
PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d postgres -c "DROP DATABASE IF EXISTS $SOURCE_DB;" -q 2>/dev/null || true
PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d postgres -c "DROP DATABASE IF EXISTS $TARGET_DB;" -q 2>/dev/null || true
PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d postgres -c "DROP DATABASE IF EXISTS $MONITORING_DB;" -q 2>/dev/null || true

PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d postgres -c "CREATE DATABASE $SOURCE_DB;" -q
PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d postgres -c "CREATE DATABASE $TARGET_DB;" -q
PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d postgres -c "CREATE DATABASE $MONITORING_DB;" -q
echo "✓ Databases created"
echo ""

# Step 2: Create test table in source database
echo "Step 2: Creating test table in source database..."
execute_sql $SOURCE_DB "
CREATE TABLE test_orders (
  id BIGINT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  product_name VARCHAR(100) NOT NULL,
  quantity INTEGER NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
"
echo "✓ Source table created"
echo ""

# Step 3: Insert test data into source
echo "Step 3: Inserting $TOTAL_ROWS rows into source database..."
execute_sql $SOURCE_DB "
INSERT INTO test_orders (id, user_id, product_name, quantity, price, status, created_at)
SELECT 
  i as id,
  (random() * 1000)::integer as user_id,
  'Product_' || (random() * 100)::integer as product_name,
  (random() * 10 + 1)::integer as quantity,
  (random() * 1000 + 10)::numeric(10, 2) as price,
  CASE (random() * 3)::integer
    WHEN 0 THEN 'pending'
    WHEN 1 THEN 'completed'
    ELSE 'cancelled'
  END as status,
  NOW() - (random() * interval '30 days') as created_at
FROM generate_series(1, $TOTAL_ROWS) as i;
"
echo "✓ Source data inserted"
echo ""

# Step 4: Create test table in target database
echo "Step 4: Creating test table in target database..."
execute_sql $TARGET_DB "
CREATE TABLE test_orders (
  id BIGINT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  product_name VARCHAR(100) NOT NULL,
  quantity INTEGER NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
"
echo "✓ Target table created"
echo ""

# Step 5: Copy data to target (excluding gaps)
echo "Step 5: Copying data to target with gaps..."
MISSING_ROWS=$(($TOTAL_ROWS * $MISSING_ROWS_PERCENT / 100))
execute_sql $TARGET_DB "
INSERT INTO test_orders 
SELECT * FROM dblink(
  'host=$PG_HOST port=$PG_PORT dbname=$SOURCE_DB user=$PG_USER password=$PG_PASSWORD',
  'SELECT * FROM test_orders WHERE id NOT IN (
    SELECT id FROM test_orders 
    ORDER BY random() 
    LIMIT $MISSING_ROWS
  )'
) AS t(
  id BIGINT,
  user_id INTEGER,
  product_name VARCHAR(100),
  quantity INTEGER,
  price NUMERIC(10, 2),
  status VARCHAR(20),
  created_at TIMESTAMP
);
" 2>/dev/null || {
  # If dblink is not available, use a simpler approach
  echo "  Note: Using alternative method (dblink not available)"
  PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $SOURCE_DB -c "
    COPY (
      SELECT * FROM test_orders 
      WHERE id NOT IN (
        SELECT id FROM test_orders 
        ORDER BY random() 
        LIMIT $MISSING_ROWS
      )
    ) TO STDOUT
  " | PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $TARGET_DB -c "COPY test_orders FROM STDIN" -q
}
echo "✓ Target data copied with gaps"
echo ""

# Step 6: Introduce mismatches in target
echo "Step 6: Introducing mismatches in target..."
MISMATCH_ROWS=$(($TOTAL_ROWS * $MISMATCH_ROWS_PERCENT / 100))
execute_sql $TARGET_DB "
UPDATE test_orders
SET 
  quantity = quantity + 1,
  price = price * 1.1,
  status = 'modified'
WHERE id IN (
  SELECT id FROM test_orders 
  ORDER BY random() 
  LIMIT $MISMATCH_ROWS
);
"
echo "✓ Mismatches introduced"
echo ""

# Step 7: Create monitoring database schema
echo "Step 7: Setting up monitoring database..."
PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $MONITORING_DB < lib/db/verification-schema.sql -q
echo "✓ Monitoring schema created"
echo ""

# Step 8: Verify setup
echo "Step 8: Verifying setup..."
SOURCE_COUNT=$(PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $SOURCE_DB -t -c "SELECT COUNT(*) FROM test_orders;")
TARGET_COUNT=$(PGPASSWORD=$PG_PASSWORD psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $TARGET_DB -t -c "SELECT COUNT(*) FROM test_orders;")

echo "  Source rows: $SOURCE_COUNT"
echo "  Target rows: $TARGET_COUNT"
echo "  Expected gaps: ~$MISSING_ROWS"
echo "  Actual gaps: $(($SOURCE_COUNT - $TARGET_COUNT))"
echo ""

echo "========================================="
echo "✓ Test Environment Ready!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Update .env file with these connection strings:"
echo "   SOURCE_DATABASE_URL=postgresql://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$SOURCE_DB"
echo "   TARGET_DATABASE_URL=postgresql://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$TARGET_DB"
echo "   MONITORING_DB_HOST=$PG_HOST"
echo "   MONITORING_DB_PORT=$PG_PORT"
echo "   MONITORING_DB_NAME=$MONITORING_DB"
echo "   MONITORING_DB_USER=$PG_USER"
echo "   MONITORING_DB_PASSWORD=$PG_PASSWORD"
echo ""
echo "2. Start verification job for table: test_orders"
echo "3. Run verification worker: npm run verification-worker"
echo ""
