#!/bin/bash
set -euo pipefail

# Add existing replication setup to the dashboard
# This reads the current replication configuration and adds it as a group

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
DB_NAME="reya"

PUBLICATION="reya_replication"
SUBSCRIPTION="reya_subscription"
SLOT="reya_subscription"

echo "========================================="
echo "Adding Existing Replication to Dashboard"
echo "========================================="
echo ""

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
  echo "❌ Error: kubectl not found. Please install kubectl first."
  exit 1
fi

# Check if secret exists
if ! kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "❌ Error: Secret $SECRET_NAME not found in namespace $NAMESPACE"
  exit 1
fi

echo "✓ Secret found: $SECRET_NAME"
echo ""

# Extract connection strings
echo "Extracting connection strings from secret..."
SOURCE_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.source-database-url}' | base64 -d)
DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.destination-database-url}' | base64 -d)

if [[ -z "$SOURCE_URL" ]] || [[ -z "$DEST_URL" ]]; then
  echo "❌ Error: Could not extract connection strings from secret"
  exit 1
fi

echo "✓ Connection strings extracted"
echo ""

# Get monitoring database connection from .env.local
if [[ ! -f .env.local ]]; then
  echo "❌ Error: .env.local not found. Run ./setup-env-from-secret.sh first."
  exit 1
fi

# Read .env.local without sourcing to avoid variable expansion issues
MONITORING_DB_HOST=$(grep "^MONITORING_DB_HOST=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'")
MONITORING_DB_PORT=$(grep "^MONITORING_DB_PORT=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" || echo "5432")
MONITORING_DB_NAME=$(grep "^MONITORING_DB_NAME=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" || echo "replication_monitoring")
MONITORING_DB_USER=$(grep "^MONITORING_DB_USER=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'")
MONITORING_DB_PASSWORD=$(grep "^MONITORING_DB_PASSWORD=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/\$/g')

if [[ -z "${MONITORING_DB_HOST:-}" ]]; then
  echo "❌ Error: MONITORING_DB_HOST not found in .env.local"
  exit 1
fi

echo "Connecting to monitoring database: ${MONITORING_DB_HOST}/${MONITORING_DB_NAME}"
echo ""

# Check if group already exists
EXISTING=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql -h "$MONITORING_DB_HOST" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" -t -A -c "
  SELECT COUNT(*) FROM replication_groups WHERE name = 'reya_replication';
" 2>/dev/null || echo "0")

if [[ "$EXISTING" == "1" ]]; then
  echo "⚠️  Group 'reya_replication' already exists in dashboard"
  read -p "Update it? [y/N]: " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted"
    exit 0
  fi
  
  echo "Updating existing group..."
  PGPASSWORD="$MONITORING_DB_PASSWORD" psql -h "$MONITORING_DB_HOST" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" <<EOF
UPDATE replication_groups
SET 
  source_db_connection = '$SOURCE_URL',
  target_db_connection = '$DEST_URL',
  publication_name = '$PUBLICATION',
  subscription_name = '$SUBSCRIPTION',
  slot_name = '$SLOT',
  updated_at = NOW()
WHERE name = 'reya_replication';
EOF
  echo "✓ Group updated"
else
  echo "Creating new group..."
  PGPASSWORD="$MONITORING_DB_PASSWORD" psql -h "$MONITORING_DB_HOST" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" <<EOF
INSERT INTO replication_groups (
  name,
  description,
  source_db_connection,
  target_db_connection,
  publication_name,
  subscription_name,
  slot_name,
  enabled
) VALUES (
  'reya_replication',
  'Main replication from RDS to Cloud SQL (existing setup)',
  '$SOURCE_URL',
  '$DEST_URL',
  '$PUBLICATION',
  '$SUBSCRIPTION',
  '$SLOT',
  true
);
EOF
  echo "✓ Group created"
fi

echo ""
echo "========================================="
echo "✓ Replication group added to dashboard"
echo "========================================="
echo ""
echo "You can now view it at: http://localhost:3002"
echo ""

