#!/usr/bin/env bash

# GCP Database Users Audit & Setup
# Verifies and creates database users from GCP Secret Manager with appropriate roles

set -e

# Check bash version (need 4.0+ for associative arrays)
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
    echo "⚠️  Warning: This script requires bash 4.0 or higher for full functionality."
    echo "   Your bash version: $BASH_VERSION"
    echo "   macOS default bash: 3.2 (doesn't support associative arrays)"
    echo ""
    echo "Options:"
    echo "  1. Install bash 4+ via Homebrew: brew install bash"
    echo "  2. Use a simpler manual approach (see below)"
    echo ""
    echo "Manual approach for checking secrets:"
    echo "  gcloud secrets versions access latest --secret=reya-mainnet-fast-indexer"
    echo ""
    exit 1
fi

echo "🔐 GCP Database Users Audit & Setup"
echo "===================================="
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

# Get all secrets that contain database connection strings
echo "1️⃣ Fetching secrets from GCP Secret Manager..."
echo "================================================"
echo ""

SECRETS=$(gcloud secrets list --format="value(name)" --filter="name~database OR name~DATABASE OR name~db OR name~DB" 2>/dev/null || echo "")

if [ -z "$SECRETS" ]; then
    echo "⚠️  No database-related secrets found. Trying broader search..."
    SECRETS=$(gcloud secrets list --format="value(name)" 2>/dev/null || echo "")
fi

if [ -z "$SECRETS" ]; then
    echo "❌ No secrets found in project $PROJECT_ID"
    exit 1
fi

echo "Found secrets:"
echo "$SECRETS" | while read secret; do
    echo "  - $secret"
done
echo ""

# Parse connection strings and extract user information
declare -A USERS_READWRITE
declare -A USERS_READONLY
declare -A USER_PASSWORDS
declare -A DB_HOSTS
declare -A DB_PORTS
declare -A DB_NAMES

echo "2️⃣ Analyzing connection strings..."
echo "===================================="
echo ""

for secret in $SECRETS; do
    echo "Checking secret: $secret"
    
    # Get secret value
    SECRET_VALUE=$(gcloud secrets versions access latest --secret="$secret" 2>/dev/null || echo "")
    
    if [ -z "$SECRET_VALUE" ]; then
        echo "  ⚠️  Cannot access secret value (may be empty or no permission)"
        continue
    fi
    
    # Check if it's JSON with DATABASE_URL fields
    if echo "$SECRET_VALUE" | jq -e . >/dev/null 2>&1; then
        # It's valid JSON
        DATABASE_URL=$(echo "$SECRET_VALUE" | jq -r '.DATABASE_URL // empty' 2>/dev/null)
        DATABASE_URL_READ=$(echo "$SECRET_VALUE" | jq -r '.DATABASE_URL_READ // empty' 2>/dev/null)
        
        if [ -n "$DATABASE_URL" ]; then
            echo "  ✅ Found DATABASE_URL (readwrite)"
            
            # Parse URL: postgresql://user:password@host:port/database
            USER=$(echo "$DATABASE_URL" | sed 's/.*:\/\/\([^:]*\):.*/\1/')
            PASSWORD=$(echo "$DATABASE_URL" | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
            HOST=$(echo "$DATABASE_URL" | sed 's/.*@\([^:]*\):.*/\1/')
            PORT=$(echo "$DATABASE_URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
            DBNAME=$(echo "$DATABASE_URL" | sed 's/.*\/\([^?]*\).*/\1/')
            
            USERS_READWRITE["$USER"]="$secret"
            USER_PASSWORDS["$USER"]="$PASSWORD"
            DB_HOSTS["$USER"]="$HOST"
            DB_PORTS["$USER"]="$PORT"
            DB_NAMES["$USER"]="$DBNAME"
            
            echo "     User: $USER"
            echo "     Host: $HOST:$PORT"
            echo "     Database: $DBNAME"
        fi
        
        if [ -n "$DATABASE_URL_READ" ]; then
            echo "  ✅ Found DATABASE_URL_READ (readonly)"
            
            USER=$(echo "$DATABASE_URL_READ" | sed 's/.*:\/\/\([^:]*\):.*/\1/')
            PASSWORD=$(echo "$DATABASE_URL_READ" | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
            HOST=$(echo "$DATABASE_URL_READ" | sed 's/.*@\([^:]*\):.*/\1/')
            PORT=$(echo "$DATABASE_URL_READ" | sed 's/.*:\([0-9]*\)\/.*/\1/')
            DBNAME=$(echo "$DATABASE_URL_READ" | sed 's/.*\/\([^?]*\).*/\1/')
            
            USERS_READONLY["$USER"]="$secret"
            USER_PASSWORDS["$USER"]="$PASSWORD"
            DB_HOSTS["$USER"]="$HOST"
            DB_PORTS["$USER"]="$PORT"
            DB_NAMES["$USER"]="$DBNAME"
            
            echo "     User: $USER"
            echo "     Host: $HOST:$PORT"
            echo "     Database: $DBNAME"
        fi
    elif echo "$SECRET_VALUE" | grep -q "postgresql://"; then
        # It's a plain connection string
        if echo "$secret" | grep -iq "read"; then
            echo "  ✅ Found read connection string (readonly)"
            TYPE="readonly"
        else
            echo "  ✅ Found connection string (readwrite)"
            TYPE="readwrite"
        fi
        
        USER=$(echo "$SECRET_VALUE" | sed 's/.*:\/\/\([^:]*\):.*/\1/')
        PASSWORD=$(echo "$SECRET_VALUE" | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
        HOST=$(echo "$SECRET_VALUE" | sed 's/.*@\([^:]*\):.*/\1/')
        PORT=$(echo "$SECRET_VALUE" | sed 's/.*:\([0-9]*\)\/.*/\1/')
        DBNAME=$(echo "$SECRET_VALUE" | sed 's/.*\/\([^?]*\).*/\1/')
        
        if [ "$TYPE" = "readwrite" ]; then
            USERS_READWRITE["$USER"]="$secret"
        else
            USERS_READONLY["$USER"]="$secret"
        fi
        
        USER_PASSWORDS["$USER"]="$PASSWORD"
        DB_HOSTS["$USER"]="$HOST"
        DB_PORTS["$USER"]="$PORT"
        DB_NAMES["$USER"]="$DBNAME"
        
        echo "     User: $USER"
        echo "     Host: $HOST:$PORT"
        echo "     Database: $DBNAME"
    fi
    echo ""
done

echo ""
echo "3️⃣ Summary of Users Found"
echo "=========================="
echo ""

echo "📝 READWRITE Users (DATABASE_URL):"
if [ ${#USERS_READWRITE[@]} -eq 0 ]; then
    echo "  (none)"
else
    for user in "${!USERS_READWRITE[@]}"; do
        echo "  - $user @ ${DB_HOSTS[$user]}:${DB_PORTS[$user]}/${DB_NAMES[$user]}"
        echo "    Source: ${USERS_READWRITE[$user]}"
    done
fi
echo ""

echo "👁️  READONLY Users (DATABASE_URL_READ):"
if [ ${#USERS_READONLY[@]} -eq 0 ]; then
    echo "  (none)"
else
    for user in "${!USERS_READONLY[@]}"; do
        echo "  - $user @ ${DB_HOSTS[$user]}:${DB_PORTS[$user]}/${DB_NAMES[$user]}"
        echo "    Source: ${USERS_READONLY[$user]}"
    done
fi
echo ""

# Generate SQL scripts for user verification and creation
echo "4️⃣ Generating SQL Scripts for User Verification"
echo "=================================================="
echo ""

cat > /tmp/verify-users.sql << 'EOF'
-- Verify Database Users and Permissions
-- Run this script on your PostgreSQL instance

\echo '=== Current Users ==='
SELECT usename, usesuper, usecreatedb, usecreaterole, usebypassrls 
FROM pg_user 
ORDER BY usename;

\echo ''
\echo '=== User Permissions on Current Database ==='
SELECT 
    grantee,
    privilege_type,
    is_grantable
FROM information_schema.role_table_grants
WHERE grantee NOT IN ('postgres', 'cloudsqladmin', 'cloudsqlsuperuser')
GROUP BY grantee, privilege_type, is_grantable
ORDER BY grantee;

\echo ''
\echo '=== Schema Permissions ==='
SELECT 
    nspname as schema_name,
    pg_catalog.pg_get_userbyid(nspowner) as owner
FROM pg_namespace
WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema'
ORDER BY nspname;

EOF

cat > /tmp/create-users.sql << 'SQL_HEADER'
-- Create/Update Database Users with Appropriate Roles
-- IMPORTANT: Review and customize before running!

BEGIN;

SQL_HEADER

# Add readwrite users
for user in "${!USERS_READWRITE[@]}"; do
    password="${USER_PASSWORDS[$user]}"
    dbname="${DB_NAMES[$user]}"
    
    cat >> /tmp/create-users.sql << SQL_RW

-- ===================================
-- READWRITE User: $user
-- ===================================

-- Create user if not exists
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$user') THEN
        CREATE USER "$user" WITH PASSWORD '$password';
        RAISE NOTICE 'Created user: $user';
    ELSE
        ALTER USER "$user" WITH PASSWORD '$password';
        RAISE NOTICE 'Updated password for user: $user';
    END IF;
END
\$\$;

-- Grant readwrite permissions
GRANT CONNECT ON DATABASE $dbname TO "$user";
GRANT USAGE ON SCHEMA public TO "$user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "$user";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "$user";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "$user";

-- Grant permissions on future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "$user";

ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT USAGE, SELECT ON SEQUENCES TO "$user";

ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT EXECUTE ON FUNCTIONS TO "$user";

SQL_RW
done

# Add readonly users
for user in "${!USERS_READONLY[@]}"; do
    password="${USER_PASSWORDS[$user]}"
    dbname="${DB_NAMES[$user]}"
    
    cat >> /tmp/create-users.sql << SQL_RO

-- ===================================
-- READONLY User: $user
-- ===================================

-- Create user if not exists
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$user') THEN
        CREATE USER "$user" WITH PASSWORD '$password';
        RAISE NOTICE 'Created user: $user';
    ELSE
        ALTER USER "$user" WITH PASSWORD '$password';
        RAISE NOTICE 'Updated password for user: $user';
    END IF;
END
\$\$;

-- Grant readonly permissions
GRANT CONNECT ON DATABASE $dbname TO "$user";
GRANT USAGE ON SCHEMA public TO "$user";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "$user";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "$user";  -- For nextval in queries
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "$user";

-- Grant permissions on future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT SELECT ON TABLES TO "$user";

ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT USAGE ON SEQUENCES TO "$user";

ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT EXECUTE ON FUNCTIONS TO "$user";

SQL_RO
done

cat >> /tmp/create-users.sql << 'SQL_FOOTER'

COMMIT;

-- Verify the changes
\echo ''
\echo '=== Verification: Users Created ==='
SELECT usename, usesuper, usecreatedb FROM pg_user WHERE usename IN (
SQL_FOOTER

# Add user list for verification
FIRST=true
for user in "${!USERS_READWRITE[@]}" "${!USERS_READONLY[@]}"; do
    if [ "$FIRST" = true ]; then
        echo "    '$user'" >> /tmp/create-users.sql
        FIRST=false
    else
        echo "    ,'$user'" >> /tmp/create-users.sql
    fi
done

cat >> /tmp/create-users.sql << 'SQL_FOOTER2'
)
ORDER BY usename;
SQL_FOOTER2

echo "✅ SQL scripts generated:"
echo "   📄 /tmp/verify-users.sql - Check existing users and permissions"
echo "   📄 /tmp/create-users.sql - Create/update users with roles"
echo ""

echo "5️⃣ Next Steps"
echo "=============="
echo ""
echo "To apply these changes:"
echo ""
echo "1. Review the generated SQL scripts:"
echo "   cat /tmp/verify-users.sql"
echo "   cat /tmp/create-users.sql"
echo ""
echo "2. Connect to your GCP PostgreSQL instance:"
echo "   gcloud sql connect YOUR_INSTANCE_NAME --user=postgres"
echo ""
echo "3. Verify current state:"
echo "   \\i /tmp/verify-users.sql"
echo ""
echo "4. Create/update users (REVIEW FIRST!):"
echo "   \\i /tmp/create-users.sql"
echo ""
echo "5. Or run directly with psql:"
echo "   psql -h <host> -p <port> -U postgres -d <database> -f /tmp/create-users.sql"
echo ""

# Optionally test connections
echo "6️⃣ Connection Test (Optional)"
echo "==============================="
echo ""
read -p "Test database connections? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "Testing connections..."
    
    for user in "${!USERS_READWRITE[@]}"; do
        host="${DB_HOSTS[$user]}"
        port="${DB_PORTS[$user]}"
        dbname="${DB_NAMES[$user]}"
        password="${USER_PASSWORDS[$user]}"
        
        echo -n "Testing $user @ $host:$port/$dbname (readwrite): "
        if PGPASSWORD="$password" psql -h "$host" -p "$port" -U "$user" -d "$dbname" -c "SELECT 1;" > /dev/null 2>&1; then
            echo "✅ Connected"
        else
            echo "❌ Failed"
        fi
    done
    
    for user in "${!USERS_READONLY[@]}"; do
        host="${DB_HOSTS[$user]}"
        port="${DB_PORTS[$user]}"
        dbname="${DB_NAMES[$user]}"
        password="${USER_PASSWORDS[$user]}"
        
        echo -n "Testing $user @ $host:$port/$dbname (readonly): "
        if PGPASSWORD="$password" psql -h "$host" -p "$port" -U "$user" -d "$dbname" -c "SELECT 1;" > /dev/null 2>&1; then
            echo "✅ Connected"
        else
            echo "❌ Failed"
        fi
    done
fi

echo ""
echo "✅ Audit Complete!"
echo ""
echo "📋 Summary:"
echo "  - Found ${#USERS_READWRITE[@]} readwrite users"
echo "  - Found ${#USERS_READONLY[@]} readonly users"
echo "  - Generated SQL scripts in /tmp/"
echo ""
echo "⚠️  IMPORTANT: Review the SQL scripts before applying!"
echo ""
