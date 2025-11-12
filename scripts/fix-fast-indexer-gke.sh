#!/bin/bash

# Quick fix for fast-indexer permission error in GKE

set -e

echo "🔧 Fixing fast-indexer permissions"
echo "=================================="
echo ""

# Get database connection from secret
echo "1️⃣ Getting database connection from GCP Secret Manager..."
SECRET_VALUE=$(gcloud secrets versions access latest --secret=reya-mainnet-fast-indexer 2>/dev/null)

if [ -z "$SECRET_VALUE" ]; then
    echo "❌ Cannot access secret: reya-mainnet-fast-indexer"
    exit 1
fi

# Parse DATABASE_URL (readwrite connection)
DATABASE_URL=$(echo "$SECRET_VALUE" | jq -r '.DATABASE_URL // empty')

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not found in secret"
    exit 1
fi

# Extract connection details
USER=$(echo "$DATABASE_URL" | sed 's/.*:\/\/\([^:]*\):.*/\1/')
PASSWORD=$(echo "$DATABASE_URL" | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
HOST=$(echo "$DATABASE_URL" | sed 's/.*@\([^:]*\):.*/\1/')
PORT=$(echo "$DATABASE_URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
DBNAME=$(echo "$DATABASE_URL" | sed 's/.*\/\([^?]*\).*/\1/')

echo "   User: $USER"
echo "   Host: $HOST:$PORT"
echo "   Database: $DBNAME"
echo ""

echo "2️⃣ Checking current permissions..."
CURRENT_PERMS=$(PGPASSWORD="$PASSWORD" psql -h "$HOST" -p "$PORT" -U postgres -d "$DBNAME" -t -A << 'SQL'
SELECT COUNT(*) 
FROM information_schema.table_privileges
WHERE grantee = 'fast_indexer'
  AND table_schema = 'public'
  AND privilege_type = 'SELECT';
SQL
)

echo "   Tables with SELECT: $CURRENT_PERMS"

if [ "$CURRENT_PERMS" = "0" ]; then
    echo "   ❌ No SELECT permissions! This is the problem."
else
    echo "   ✅ Has some SELECT permissions"
fi
echo ""

echo "3️⃣ Applying permission fix..."
PGPASSWORD="$PASSWORD" psql -h "$HOST" -p "$PORT" -U postgres -d "$DBNAME" << 'SQL'
BEGIN;

-- Grant all required permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fast_indexer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fast_indexer;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO fast_indexer;

-- Grant on future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fast_indexer;

ALTER DEFAULT PRIVILEGES IN SCHEMA public 
GRANT USAGE, SELECT ON SEQUENCES TO fast_indexer;

COMMIT;

-- Verify
SELECT 
    privilege_type,
    COUNT(*) as table_count
FROM information_schema.table_privileges
WHERE grantee = 'fast_indexer'
  AND table_schema = 'public'
GROUP BY privilege_type
ORDER BY privilege_type;
SQL

echo ""
echo "4️⃣ Restarting fast-indexer pod in GKE..."
kubectl rollout restart deployment/reya-mainnet-fast-indexer -n reya-mainnet

echo ""
echo "5️⃣ Watching pod restart..."
kubectl get pods -n reya-mainnet -l app=reya-mainnet-fast-indexer -w &
WATCH_PID=$!

sleep 10
kill $WATCH_PID 2>/dev/null || true

echo ""
echo "6️⃣ Check logs for errors..."
POD_NAME=$(kubectl get pods -n reya-mainnet -l app=reya-mainnet-fast-indexer -o jsonpath='{.items[0].metadata.name}')
echo "   Pod: $POD_NAME"
echo ""
kubectl logs -n reya-mainnet "$POD_NAME" --tail=20

echo ""
echo "✅ Fix applied!"
echo ""
echo "Next steps:"
echo "  - Monitor logs: kubectl logs -f -n reya-mainnet $POD_NAME"
echo "  - Check status: kubectl get pods -n reya-mainnet -l app=reya-mainnet-fast-indexer"
echo ""
