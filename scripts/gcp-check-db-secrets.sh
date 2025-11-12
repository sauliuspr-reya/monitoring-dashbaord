#!/bin/bash

# Simple GCP Database Secrets Checker (macOS compatible)
# Works with bash 3.2+ (default on macOS)

set -e

echo "🔐 GCP Database Secrets Checker"
echo "================================"
echo ""

# Check for gcloud CLI
if ! command -v gcloud &> /dev/null; then
    echo "❌ Error: gcloud CLI not found. Please install: https://cloud.google.com/sdk/install"
    exit 1
fi

# Get current GCP project
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
if [ -z "$PROJECT_ID" ]; then
    echo "❌ Error: No GCP project configured. Run: gcloud config set project PROJECT_ID"
    exit 1
fi

echo "📋 Project: $PROJECT_ID"
echo ""

# Key secrets to check (based on the list from your GCP)
SECRETS_TO_CHECK=(
    "reya-mainnet-fast-indexer"
    "reya-mainnet-api"
    "reya-mainnet-api-stg"
    "reya-mainnet-state-indexer"
    "reya-mainnet-monitoring"
    "reya-mainnet-reya-admin-ro"
    "reya-mainnet-fast-indexer-monitoring-ro"
)

echo "1️⃣ Checking Database Connection Secrets"
echo "========================================="
echo ""

USERS_FOUND=""
USERS_FILE="/tmp/gcp-db-users-$(date +%s).txt"

for secret in "${SECRETS_TO_CHECK[@]}"; do
    echo "Checking: $secret"
    
    # Get secret value
    SECRET_VALUE=$(gcloud secrets versions access latest --secret="$secret" 2>/dev/null || echo "")
    
    if [ -z "$SECRET_VALUE" ]; then
        echo "  ⚠️  Cannot access secret"
        echo ""
        continue
    fi
    
    # Check if it's JSON with DATABASE_URL
    if echo "$SECRET_VALUE" | jq -e . >/dev/null 2>&1; then
        # It's valid JSON
        DATABASE_URL=$(echo "$SECRET_VALUE" | jq -r '.DATABASE_URL // empty' 2>/dev/null)
        DATABASE_URL_READ=$(echo "$SECRET_VALUE" | jq -r '.DATABASE_URL_READ // empty' 2>/dev/null)
        
        if [ -n "$DATABASE_URL" ]; then
            echo "  ✅ Found DATABASE_URL (readwrite)"
            
            # Parse URL
            USER=$(echo "$DATABASE_URL" | sed 's/.*:\/\/\([^:]*\):.*/\1/')
            PASSWORD=$(echo "$DATABASE_URL" | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
            HOST=$(echo "$DATABASE_URL" | sed 's/.*@\([^:]*\):.*/\1/')
            PORT=$(echo "$DATABASE_URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
            DBNAME=$(echo "$DATABASE_URL" | sed 's/.*\/\([^?]*\).*/\1/')
            
            echo "     User: $USER"
            echo "     Host: $HOST:$PORT"
            echo "     Database: $DBNAME"
            echo "     Role: READWRITE"
            
            # Save to file
            echo "SECRET=$secret|USER=$USER|HOST=$HOST|PORT=$PORT|DB=$DBNAME|ROLE=READWRITE|PASSWORD=$PASSWORD" >> "$USERS_FILE"
            USERS_FOUND="yes"
        fi
        
        if [ -n "$DATABASE_URL_READ" ]; then
            echo "  ✅ Found DATABASE_URL_READ (readonly)"
            
            USER=$(echo "$DATABASE_URL_READ" | sed 's/.*:\/\/\([^:]*\):.*/\1/')
            PASSWORD=$(echo "$DATABASE_URL_READ" | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
            HOST=$(echo "$DATABASE_URL_READ" | sed 's/.*@\([^:]*\):.*/\1/')
            PORT=$(echo "$DATABASE_URL_READ" | sed 's/.*:\([0-9]*\)\/.*/\1/')
            DBNAME=$(echo "$DATABASE_URL_READ" | sed 's/.*\/\([^?]*\).*/\1/')
            
            echo "     User: $USER"
            echo "     Host: $HOST:$PORT"
            echo "     Database: $DBNAME"
            echo "     Role: READONLY"
            
            # Save to file
            echo "SECRET=$secret|USER=$USER|HOST=$HOST|PORT=$PORT|DB=$DBNAME|ROLE=READONLY|PASSWORD=$PASSWORD" >> "$USERS_FILE"
            USERS_FOUND="yes"
        fi
    elif echo "$SECRET_VALUE" | grep -q "postgresql://"; then
        # It's a plain connection string
        echo "  ✅ Found connection string"
        
        if echo "$secret" | grep -iq "read\|ro"; then
            ROLE="READONLY"
        else
            ROLE="READWRITE"
        fi
        
        USER=$(echo "$SECRET_VALUE" | sed 's/.*:\/\/\([^:]*\):.*/\1/')
        PASSWORD=$(echo "$SECRET_VALUE" | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
        HOST=$(echo "$SECRET_VALUE" | sed 's/.*@\([^:]*\):.*/\1/')
        PORT=$(echo "$SECRET_VALUE" | sed 's/.*:\([0-9]*\)\/.*/\1/')
        DBNAME=$(echo "$SECRET_VALUE" | sed 's/.*\/\([^?]*\).*/\1/')
        
        echo "     User: $USER"
        echo "     Host: $HOST:$PORT"
        echo "     Database: $DBNAME"
        echo "     Role: $ROLE"
        
        # Save to file
        echo "SECRET=$secret|USER=$USER|HOST=$HOST|PORT=$PORT|DB=$DBNAME|ROLE=$ROLE|PASSWORD=$PASSWORD" >> "$USERS_FILE"
        USERS_FOUND="yes"
    else
        echo "  ℹ️  Not a database connection string"
    fi
    
    echo ""
done

if [ -z "$USERS_FOUND" ]; then
    echo "❌ No database users found in checked secrets"
    exit 1
fi

echo ""
echo "2️⃣ Summary of Users Found"
echo "=========================="
echo ""

echo "📝 READWRITE Users:"
grep "ROLE=READWRITE" "$USERS_FILE" | while IFS='|' read -r line; do
    SECRET=$(echo "$line" | sed 's/SECRET=\([^|]*\)|.*/\1/')
    USER=$(echo "$line" | sed 's/.*USER=\([^|]*\)|.*/\1/')
    HOST=$(echo "$line" | sed 's/.*HOST=\([^|]*\)|.*/\1/')
    PORT=$(echo "$line" | sed 's/.*PORT=\([^|]*\)|.*/\1/')
    DB=$(echo "$line" | sed 's/.*DB=\([^|]*\)|.*/\1/')
    echo "  - $USER @ $HOST:$PORT/$DB (from: $SECRET)"
done

echo ""
echo "👁️  READONLY Users:"
grep "ROLE=READONLY" "$USERS_FILE" | while IFS='|' read -r line; do
    SECRET=$(echo "$line" | sed 's/SECRET=\([^|]*\)|.*/\1/')
    USER=$(echo "$line" | sed 's/.*USER=\([^|]*\)|.*/\1/')
    HOST=$(echo "$line" | sed 's/.*HOST=\([^|]*\)|.*/\1/')
    PORT=$(echo "$line" | sed 's/.*PORT=\([^|]*\)|.*/\1/')
    DB=$(echo "$line" | sed 's/.*DB=\([^|]*\)|.*/\1/')
    echo "  - $USER @ $HOST:$PORT/$DB (from: $SECRET)"
done

echo ""
echo "3️⃣ Generating SQL Setup Script"
echo "================================"
echo ""

SQL_FILE="/tmp/setup-gcp-db-users.sql"

cat > "$SQL_FILE" << 'SQL_HEADER'
-- =====================================================
-- GCP Database Users Setup
-- =====================================================
-- Generated from GCP Secret Manager secrets

BEGIN;

SQL_HEADER

# Process READWRITE users
grep "ROLE=READWRITE" "$USERS_FILE" | while IFS='|' read -r line; do
    USER=$(echo "$line" | sed 's/.*USER=\([^|]*\)|.*/\1/')
    PASSWORD=$(echo "$line" | sed 's/.*PASSWORD=\([^|]*\)$/\1/')
    DB=$(echo "$line" | sed 's/.*DB=\([^|]*\)|.*/\1/')
    
    cat >> "$SQL_FILE" << SQL_RW

-- ===================================
-- READWRITE User: $USER
-- ===================================

DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$USER') THEN
        CREATE USER "$USER" WITH PASSWORD '$PASSWORD';
        RAISE NOTICE 'Created user: $USER';
    ELSE
        ALTER USER "$USER" WITH PASSWORD '$PASSWORD';
        RAISE NOTICE 'Updated password for user: $USER';
    END IF;
END
\$\$;

-- Grant readwrite permissions
GRANT CONNECT ON DATABASE $DB TO "$USER";
GRANT USAGE ON SCHEMA public TO "$USER";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "$USER";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "$USER";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "$USER";

-- Grant permissions on future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "$USER";

ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT USAGE, SELECT ON SEQUENCES TO "$USER";

SQL_RW
done

# Process READONLY users
grep "ROLE=READONLY" "$USERS_FILE" | while IFS='|' read -r line; do
    USER=$(echo "$line" | sed 's/.*USER=\([^|]*\)|.*/\1/')
    PASSWORD=$(echo "$line" | sed 's/.*PASSWORD=\([^|]*\)$/\1/')
    DB=$(echo "$line" | sed 's/.*DB=\([^|]*\)|.*/\1/')
    
    cat >> "$SQL_FILE" << SQL_RO

-- ===================================
-- READONLY User: $USER
-- ===================================

DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$USER') THEN
        CREATE USER "$USER" WITH PASSWORD '$PASSWORD';
        RAISE NOTICE 'Created user: $USER';
    ELSE
        ALTER USER "$USER" WITH PASSWORD '$PASSWORD';
        RAISE NOTICE 'Updated password for user: $USER';
    END IF;
END
\$\$;

-- Grant readonly permissions
GRANT CONNECT ON DATABASE $DB TO "$USER";
GRANT USAGE ON SCHEMA public TO "$USER";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "$USER";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "$USER";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "$USER";

-- Grant permissions on future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT SELECT ON TABLES TO "$USER";

SQL_RO
done

cat >> "$SQL_FILE" << 'SQL_FOOTER'

COMMIT;

\echo ''
\echo '=== Setup Complete! ==='
SQL_FOOTER

echo "✅ SQL script generated: $SQL_FILE"
echo ""

echo "4️⃣ Connection Test Scripts"
echo "==========================="
echo ""

TEST_SCRIPT="/tmp/test-gcp-db-connections.sh"
cat > "$TEST_SCRIPT" << 'TEST_HEADER'
#!/bin/bash
# Test database connections for GCP users

echo "Testing database connections..."
echo ""

TEST_HEADER

chmod +x "$TEST_SCRIPT"

cat "$USERS_FILE" | while IFS='|' read -r line; do
    USER=$(echo "$line" | sed 's/.*USER=\([^|]*\)|.*/\1/')
    HOST=$(echo "$line" | sed 's/.*HOST=\([^|]*\)|.*/\1/')
    PORT=$(echo "$line" | sed 's/.*PORT=\([^|]*\)|.*/\1/')
    DB=$(echo "$line" | sed 's/.*DB=\([^|]*\)|.*/\1/')
    PASSWORD=$(echo "$line" | sed 's/.*PASSWORD=\([^|]*\)$/\1/')
    ROLE=$(echo "$line" | sed 's/.*ROLE=\([^|]*\)|.*/\1/')
    
    cat >> "$TEST_SCRIPT" << TEST_CONN
echo -n "Testing $USER @ $HOST:$PORT/$DB ($ROLE): "
if PGPASSWORD="$PASSWORD" psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -c "SELECT 1;" > /dev/null 2>&1; then
    echo "✅ Connected"
else
    echo "❌ Failed"
fi

TEST_CONN
done

echo "✅ Test script generated: $TEST_SCRIPT"
echo ""

echo "5️⃣ Next Steps"
echo "=============="
echo ""
echo "📄 Files generated:"
echo "  - $SQL_FILE"
echo "  - $TEST_SCRIPT"
echo "  - $USERS_FILE (data file)"
echo ""
echo "🔧 To apply user setup:"
echo "  psql -h <host> -U postgres -d <database> -f $SQL_FILE"
echo ""
echo "🧪 To test connections:"
echo "  $TEST_SCRIPT"
echo ""
echo "✅ Audit Complete!"
echo ""

# Clean up (keep files for manual review)
echo "💾 Keeping files for review. Delete manually when done:"
echo "  rm $USERS_FILE $SQL_FILE $TEST_SCRIPT"
echo ""
