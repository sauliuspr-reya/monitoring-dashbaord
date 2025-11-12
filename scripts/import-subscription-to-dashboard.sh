#!/bin/bash

set -euo pipefail

# Import an existing PostgreSQL logical replication subscription into the monitoring dashboard
# This script reads an existing pg_subscription and adds it to the monitoring database

echo "=========================================="
echo "Import Subscription to Dashboard"
echo "=========================================="
echo ""

# Get credentials
NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"

if kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "✓ Found K8s secret"
  SOURCE_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.source-database-url}' | base64 -d)
  DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)
  MONITORING_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.monitoring-database-url}' | base64 -d 2>/dev/null || echo "")
else
  echo "Using environment variables..."
  SOURCE_URL="${SOURCE_DATABASE_URL:-}"
  DEST_URL="${TARGET_DATABASE_URL:-}"
  MONITORING_URL="${MONITORING_DATABASE_URL:-}"
fi

if [[ -z "$SOURCE_URL" ]] || [[ -z "$DEST_URL" ]]; then
  echo "❌ Error: Database URLs not configured"
  exit 1
fi

if [[ -z "$MONITORING_URL" ]]; then
  echo "❌ Error: Monitoring database URL not configured"
  echo "Set MONITORING_DATABASE_URL environment variable"
  exit 1
fi

# Parse connection details
parse_url() {
  local url=$1
  python3 -c "
from urllib.parse import urlparse, unquote
url = urlparse('$url')
print(f'{url.hostname or \"localhost\"}|{url.port or 5432}|{unquote(url.username or \"postgres\")}|{unquote(url.password or \"\")}|{url.path.lstrip(\"/\") or \"reya\"}')
"
}

IFS='|' read -r DEST_HOST DEST_PORT DEST_USER DEST_PASS DEST_DB <<< "$(parse_url "$DEST_URL")"
IFS='|' read -r MON_HOST MON_PORT MON_USER MON_PASS MON_DB <<< "$(parse_url "$MONITORING_URL")"

echo ""
echo "Fetching PostgreSQL subscriptions from GCP..."

# Get list of subscriptions
SUBSCRIPTIONS=$(PGPASSWORD="$DEST_PASS" psql -h "$DEST_HOST" -p "$DEST_PORT" -U "$DEST_USER" -d "$DEST_DB" -t -A -c "
  SELECT 
    subname || '|' || 
    COALESCE((SELECT array_to_string(array_agg(pubname), ',') FROM unnest(subpublications) AS pubname), 'unknown') || '|' ||
    CASE WHEN subenabled THEN 'true' ELSE 'false' END
  FROM pg_subscription
  ORDER BY subname;
" 2>/dev/null)

if [[ -z "$SUBSCRIPTIONS" ]]; then
  echo "❌ No PostgreSQL subscriptions found on GCP"
  echo "You need to create a subscription first"
  exit 1
fi

echo "Found subscriptions:"
echo ""

# Display subscriptions with numbers
i=1
declare -a SUB_ARRAY
while IFS='|' read -r subname pubname enabled; do
  if [[ -n "$subname" ]]; then
    SUB_ARRAY[$i]="$subname|$pubname|$enabled"
    echo "  [$i] $subname"
    echo "      Publication: $pubname"
    echo "      Enabled: $enabled"
    echo ""
    i=$((i+1))
  fi
done <<< "$SUBSCRIPTIONS"

# Ask user to select
if [[ ${#SUB_ARRAY[@]} -eq 0 ]]; then
  echo "❌ No valid subscriptions found"
  exit 1
fi

if [[ ${#SUB_ARRAY[@]} -eq 1 ]]; then
  echo "Only one subscription found, using it..."
  SELECTED=1
else
  read -p "Select subscription to import [1-${#SUB_ARRAY[@]}]: " SELECTED
  
  if ! [[ "$SELECTED" =~ ^[0-9]+$ ]] || [[ "$SELECTED" -lt 1 ]] || [[ "$SELECTED" -gt ${#SUB_ARRAY[@]} ]]; then
    echo "❌ Invalid selection"
    exit 1
  fi
fi

IFS='|' read -r SUB_NAME PUB_NAME SUB_ENABLED <<< "${SUB_ARRAY[$SELECTED]}"

echo ""
echo "Selected subscription: $SUB_NAME"
echo "Publication: $PUB_NAME"
echo ""

# Ask for friendly name
read -p "Enter a friendly name for this subscription [$SUB_NAME]: " FRIENDLY_NAME
FRIENDLY_NAME=${FRIENDLY_NAME:-$SUB_NAME}

read -p "Enter a description (optional): " DESCRIPTION

# Generate slot name (convention: subscription name is often the same as slot name)
SLOT_NAME=$SUB_NAME

echo ""
echo "Importing to monitoring database..."
echo ""

# Check if table exists (handle both old and new table names)
TABLE_EXISTS=$(PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" -t -A -c "
  SELECT EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name = 'subscriptions'
  );
" 2>/dev/null || echo "f")

if [[ "$TABLE_EXISTS" == "f" ]]; then
  # Try old table name
  TABLE_EXISTS=$(PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" -t -A -c "
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'replication_groups'
    );
  " 2>/dev/null || echo "f")
  
  if [[ "$TABLE_EXISTS" == "t" ]]; then
    TABLE_NAME="replication_groups"
  else
    echo "❌ Monitoring database schema not found"
    echo "Run: psql < lib/db/schema.sql"
    exit 1
  fi
else
  TABLE_NAME="subscriptions"
fi

# Check if subscription already exists
EXISTING=$(PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" -t -A -c "
  SELECT COUNT(*) FROM $TABLE_NAME WHERE subscription_name = '$SUB_NAME';
" 2>/dev/null || echo "0")

if [[ "$EXISTING" != "0" ]]; then
  echo "⚠️  Subscription '$SUB_NAME' already exists in monitoring database"
  read -p "Update it? [y/N]: " UPDATE
  
  if [[ ! "$UPDATE" =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 0
  fi
  
  # Update existing
  PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" << EOF
UPDATE $TABLE_NAME SET
  name = '$FRIENDLY_NAME',
  description = '$DESCRIPTION',
  publication_name = '$PUB_NAME',
  enabled = ${SUB_ENABLED},
  updated_at = NOW()
WHERE subscription_name = '$SUB_NAME';
EOF
  
  echo "✓ Updated subscription in monitoring database"
else
  # Insert new
  PGPASSWORD="$MON_PASS" psql -h "$MON_HOST" -p "$MON_PORT" -U "$MON_USER" -d "$MON_DB" << EOF
INSERT INTO $TABLE_NAME (
  name,
  description,
  source_db_connection,
  target_db_connection,
  publication_name,
  subscription_name,
  slot_name,
  enabled
) VALUES (
  '$FRIENDLY_NAME',
  '$DESCRIPTION',
  '$SOURCE_URL',
  '$DEST_URL',
  '$PUB_NAME',
  '$SUB_NAME',
  '$SLOT_NAME',
  ${SUB_ENABLED}
);
EOF
  
  echo "✓ Added subscription to monitoring database"
fi

echo ""
echo "=========================================="
echo "✓ Import Complete"
echo "=========================================="
echo ""
echo "The subscription is now tracked in the dashboard."
echo "Open http://localhost:3002 to view it."
echo ""
echo "The dashboard will now show:"
echo "  - All tables in the publication"
echo "  - Replication status and lag"
echo "  - Row count comparisons"
echo ""

