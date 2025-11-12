#!/bin/bash
set -euo pipefail

# Extract database connection strings from Kubernetes secret
# and create .env.local file for the Next.js dashboard

NAMESPACE="postgres-replication"
SECRET_NAME="postgres-replication-secrets"
ENV_FILE=".env.local"

echo "========================================="
echo "Setting up .env.local from Kubernetes secret"
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
  echo ""
  echo "Please create the secret first:"
  echo "  kubectl create secret generic $SECRET_NAME -n $NAMESPACE \\"
  echo "    --from-literal=source-database-url='postgresql://user:pass@host:5432/db' \\"
  echo "    --from-literal=destination-database-url='postgresql://user:pass@host:5432/db'"
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

# Parse connection strings to extract components
# Format: postgresql://user:password@host:port/database

parse_db_url() {
  local url=$1
  echo "$url" | sed -n 's|postgresql://\([^:]*\):\([^@]*\)@\([^:]*\):\([^/]*\)/\(.*\)|\1|\2|\3|\4|\5|p' | tr '|' '\n'
}

# For monitoring database, we'll use the destination (Cloud SQL) as default
# User can override this in .env.local if needed

# Use Python to properly parse the URL and handle URL encoding
MONITORING_DB_HOST=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(url.hostname or '')")
MONITORING_DB_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.port or 5432)")
MONITORING_DB_NAME="replication_monitoring"  # Default monitoring database name
MONITORING_DB_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.username or ''))")
MONITORING_DB_PASSWORD=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.password or ''))")

# If we can't parse, ask user
if [[ -z "$MONITORING_DB_HOST" ]]; then
  echo "⚠️  Could not parse destination database URL automatically"
  echo ""
  read -p "Enter monitoring database host: " MONITORING_DB_HOST
  read -p "Enter monitoring database port [5432]: " MONITORING_DB_PORT
  MONITORING_DB_PORT=${MONITORING_DB_PORT:-5432}
  read -p "Enter monitoring database name [replication_monitoring]: " MONITORING_DB_NAME
  MONITORING_DB_NAME=${MONITORING_DB_NAME:-replication_monitoring}
  read -p "Enter monitoring database user: " MONITORING_DB_USER
  read -sp "Enter monitoring database password: " MONITORING_DB_PASSWORD
  echo ""
fi

# Create .env.local file
echo "Creating $ENV_FILE..."

# Use printf to properly escape the password
{
  echo "# Monitoring Database (stores metrics and configs)"
  echo "# This is a separate database for storing replication monitoring data"
  echo "MONITORING_DB_HOST=${MONITORING_DB_HOST}"
  echo "MONITORING_DB_PORT=${MONITORING_DB_PORT}"
  echo "MONITORING_DB_NAME=${MONITORING_DB_NAME}"
  echo "MONITORING_DB_USER=${MONITORING_DB_USER}"
  # Escape $ in password for .env file (since $ is used for variable expansion)
  ESCAPED_PASSWORD=$(echo "${MONITORING_DB_PASSWORD}" | sed 's/\$/\\$/g')
  printf 'MONITORING_DB_PASSWORD=%s\n' "${ESCAPED_PASSWORD}"

  echo ""
  echo "# Next.js"
  echo "NODE_ENV=development"
  echo "NEXT_PUBLIC_APP_URL=http://localhost:3002"
  echo ""
  echo "# Source and Target Database URLs (for reference, used when creating groups)"
  echo "# These are extracted from the Kubernetes secret but not used directly in env"
  echo "# They will be stored in the monitoring database when you create replication groups"
  printf 'SOURCE_DATABASE_URL=%s\n' "${SOURCE_URL}"
  printf 'DESTINATION_DATABASE_URL=%s\n' "${DEST_URL}"
} > "$ENV_FILE"

echo "✓ Created $ENV_FILE"
echo ""
echo "========================================="
echo "Next steps:"
echo "========================================="
echo ""
echo "1. Review $ENV_FILE and adjust if needed"
echo "2. Create the monitoring database:"
echo "   psql -h ${MONITORING_DB_HOST} -U ${MONITORING_DB_USER} -d postgres -c 'CREATE DATABASE ${MONITORING_DB_NAME};'"
echo ""
echo "3. Run the database schema:"
echo "   psql -h ${MONITORING_DB_HOST} -U ${MONITORING_DB_USER} -d ${MONITORING_DB_NAME} < lib/db/schema.sql"
echo ""
echo "4. Start the dashboard:"
echo "   npm run dev"
echo ""
echo "========================================="

