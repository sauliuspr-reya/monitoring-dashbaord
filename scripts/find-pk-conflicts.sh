#!/bin/bash
set -euo pipefail

# Find tables with primary key conflicts by querying Cloud SQL logs
# Uses gcloud logging or PostgreSQL error logs

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"

echo "========================================="
echo "Finding Primary Key Conflicts"
echo "========================================="
echo ""

# Get credentials
if ! kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "❌ Error: Secret not found"
  exit 1
fi

DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)

DEST_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$DEST_URL').hostname)")
DEST_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.port or 5432)")
DEST_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.username or ''))")
DEST_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.password or ''))")
DEST_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.path.lstrip('/'))")

echo "Connecting to: ${DEST_HOST}:${DEST_PORT}/${DEST_DB}"
echo ""

# Method 1: Check pg_subscription_rel for tables in error state
echo "1. Checking pg_subscription_rel for tables in error state..."
ERROR_TABLES=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT DISTINCT srrelid::regclass::text
  FROM pg_subscription_rel
  WHERE srsubstate = 'e';
" 2>/dev/null || echo "")

if [[ -n "$ERROR_TABLES" ]]; then
  echo "❌ Tables in error state:"
  echo "$ERROR_TABLES" | while read -r table; do
    if [[ -n "$table" ]]; then
      echo "  - $table"
    fi
  done
  echo ""
else
  echo "✓ No tables in error state (pg_subscription_rel)"
  echo ""
fi

# Method 2: Check pg_stat_activity for aborted transactions
echo "2. Checking for aborted transactions..."
ABORTED=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT 
    application_name || '|' ||
    state || '|' ||
    LEFT(query, 100)
  FROM pg_stat_activity
  WHERE state = 'idle in transaction (aborted)'
    AND query NOT LIKE '%pg_stat%';
" 2>/dev/null || echo "")

if [[ -n "$ABORTED" ]]; then
  echo "⚠️  Aborted transactions found:"
  echo "$ABORTED" | while IFS='|' read -r app state query; do
    if [[ -n "$app" ]]; then
      echo "  - $app: $query"
    fi
  done
  echo ""
else
  echo "✓ No aborted transactions"
  echo ""
fi

# Method 3: Try to query GCP logs if gcloud is available
echo "3. Querying GCP Cloud SQL logs (last 24 hours)..."
if command -v gcloud &> /dev/null; then
  # Try to get project and instance from environment or config
  PROJECT_ID="${GCP_PROJECT_ID:-mainnet-473609}"
  INSTANCE_ID="${GCP_CLOUD_SQL_INSTANCE_ID:-reya-mainnet-gcp}"
  
  FILTER="resource.type=\"cloudsql_database\"
    resource.labels.database_id=\"${PROJECT_ID}:${INSTANCE_ID}\"
    severity>=ERROR
    (textPayload=~\"duplicate key\" OR textPayload=~\"violates unique constraint\" OR textPayload=~\"primary key\")
    timestamp>=\"$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)\""

  LOGS=$(gcloud logging read "$FILTER" \
    --project="$PROJECT_ID" \
    --format="table(timestamp,severity,textPayload)" \
    --limit=50 \
    --freshness=1d 2>/dev/null || echo "")

  if [[ -n "$LOGS" ]]; then
    echo "Found errors in GCP logs:"
    echo "$LOGS" | head -20
    echo ""
    
    # Extract table names
    echo "Tables with conflicts (from logs):"
    echo "$LOGS" | grep -i "duplicate key\|violates unique constraint" | \
      sed -n 's/.*constraint "\([^"]*\)".*/\1/p' | \
      sed 's/_pkey$//' | \
      sed 's/_\([^_]*\)_key$//' | \
      sort -u | \
      while read -r table; do
        if [[ -n "$table" ]]; then
          echo "  - $table"
        fi
      done
  else
    echo "No errors found in GCP logs (or gcloud not configured)"
  fi
else
  echo "gcloud CLI not available. Install it to query GCP logs."
fi

echo ""
echo "========================================="
echo "Summary"
echo "========================================="
echo ""

# Final summary
if [[ -n "$ERROR_TABLES" ]]; then
  echo "❌ Tables with replication errors:"
  echo "$ERROR_TABLES" | while read -r table; do
    if [[ -n "$table" ]]; then
      echo "  - $table"
    fi
  done
  echo ""
  echo "To fix:"
  echo "  1. Check the specific error for each table"
  echo "  2. Resolve the conflict (remove duplicates, fix data)"
  echo "  3. Refresh the subscription: ALTER SUBSCRIPTION reya_subscription REFRESH PUBLICATION;"
else
  echo "✓ No tables currently in error state"
fi

echo ""
echo "Next steps:"
echo "  1. Review the tables above"
echo "  2. Check specific errors: psql -h $DEST_HOST -U $DEST_USER -d $DEST_DB -c \"SELECT * FROM pg_subscription_rel WHERE srsubstate = 'e';\""
echo "  3. Query GCP logs for detailed error messages"
echo ""

