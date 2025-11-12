#!/bin/bash

# Quick verification for fast_indexer user from GCP secrets

set -e

echo "🔍 Verifying fast_indexer User"
echo "==============================="
echo ""

# Connection details from the secret
RW_HOST="10.107.240.2"
RW_PORT="5432"
RO_HOST="10.107.240.7"
RO_PORT="5432"
DB_NAME="reya"
USER="fast_indexer"
PASSWORD="LLUohqPtWhRC4053"

echo "Testing connections for user: $USER"
echo ""

# Test readwrite connection
echo "1️⃣ Testing READWRITE connection ($RW_HOST:$RW_PORT)..."
echo "   Expected: Should be able to SELECT, INSERT, UPDATE, DELETE"
echo ""

if PGPASSWORD="$PASSWORD" psql -h "$RW_HOST" -p "$RW_PORT" -U "$USER" -d "$DB_NAME" -c "SELECT 1 as connected;" 2>&1 | grep -q "connected"; then
    echo "   ✅ Connection successful"
    
    # Test write permissions
    echo "   Testing write permissions..."
    WRITE_TEST=$(PGPASSWORD="$PASSWORD" psql -h "$RW_HOST" -p "$RW_PORT" -U "$USER" -d "$DB_NAME" -t -A << 'SQL'
BEGIN;
CREATE TEMP TABLE test_write_perms (id int);
INSERT INTO test_write_perms VALUES (1);
SELECT 'WRITE_OK';
ROLLBACK;
SQL
)
    
    if echo "$WRITE_TEST" | grep -q "WRITE_OK"; then
        echo "   ✅ Write permissions: OK"
    else
        echo "   ❌ Write permissions: FAILED"
        echo "   $WRITE_TEST"
    fi
    
    # Check actual permissions
    echo ""
    echo "   Current permissions on public schema:"
    PGPASSWORD="$PASSWORD" psql -h "$RW_HOST" -p "$RW_PORT" -U "$USER" -d "$DB_NAME" << 'SQL'
SELECT 
    privilege_type,
    is_grantable
FROM information_schema.table_privileges
WHERE grantee = 'fast_indexer'
  AND table_schema = 'public'
GROUP BY privilege_type, is_grantable
ORDER BY privilege_type;
SQL

else
    echo "   ❌ Connection failed!"
    echo "   User may not exist or password is incorrect"
fi

echo ""
echo "2️⃣ Testing READONLY connection ($RO_HOST:$RO_PORT)..."
echo "   Expected: Should be able to SELECT only"
echo ""

if PGPASSWORD="$PASSWORD" psql -h "$RO_HOST" -p "$RO_PORT" -U "$USER" -d "$DB_NAME" -c "SELECT 1 as connected;" 2>&1 | grep -q "connected"; then
    echo "   ✅ Connection successful"
    
    # Test that write is blocked
    echo "   Testing that write is blocked..."
    WRITE_TEST=$(PGPASSWORD="$PASSWORD" psql -h "$RO_HOST" -p "$RO_PORT" -U "$USER" -d "$DB_NAME" -t -A 2>&1 << 'SQL'
BEGIN;
CREATE TEMP TABLE test_readonly (id int);
ROLLBACK;
SQL
)
    
    if echo "$WRITE_TEST" | grep -q "permission denied"; then
        echo "   ✅ Write blocked: OK (readonly working correctly)"
    else
        echo "   ⚠️  Write not blocked - this should be readonly!"
        echo "   $WRITE_TEST"
    fi
    
    # Check actual permissions
    echo ""
    echo "   Current permissions on public schema:"
    PGPASSWORD="$PASSWORD" psql -h "$RO_HOST" -p "$RO_PORT" -U "$USER" -d "$DB_NAME" << 'SQL'
SELECT 
    privilege_type,
    is_grantable
FROM information_schema.table_privileges
WHERE grantee = 'fast_indexer'
  AND table_schema = 'public'
GROUP BY privilege_type, is_grantable
ORDER BY privilege_type;
SQL

else
    echo "   ❌ Connection failed!"
    echo "   User may not exist or password is incorrect"
fi

echo ""
echo "3️⃣ Checking if user exists on both instances..."
echo ""

echo "On $RW_HOST (readwrite):"
PGPASSWORD="$PASSWORD" psql -h "$RW_HOST" -p "$RW_PORT" -U "$USER" -d "$DB_NAME" -c "SELECT current_user, session_user, inet_server_addr(), inet_server_port();"

echo ""
echo "On $RO_HOST (readonly):"
PGPASSWORD="$PASSWORD" psql -h "$RO_HOST" -p "$RO_PORT" -U "$USER" -d "$DB_NAME" -c "SELECT current_user, session_user, inet_server_addr(), inet_server_port();"

echo ""
echo "✅ Verification Complete!"
echo ""
echo "Expected setup:"
echo "  - $RW_HOST: fast_indexer with READWRITE (SELECT, INSERT, UPDATE, DELETE)"
echo "  - $RO_HOST: fast_indexer with READONLY (SELECT only)"
echo ""
