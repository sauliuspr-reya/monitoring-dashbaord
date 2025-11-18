#!/bin/bash
set -euo pipefail

# Setup script for Data Integrity Verification System
# This script creates the necessary database tables for verification

echo "========================================="
echo "Setup Data Integrity Verification System"
echo "========================================="
echo ""

# Load .env file if it exists
if [ -f .env ]; then
  echo "Loading environment variables from .env file..."
  export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)
  echo ""
fi

# Get database connection from environment or prompt
MONITORING_DB_HOST="${MONITORING_DB_HOST:-localhost}"
MONITORING_DB_PORT="${MONITORING_DB_PORT:-5432}"
MONITORING_DB_USER="${MONITORING_DB_USER:-postgres}"
MONITORING_DB_NAME="${MONITORING_DB_NAME:-replication_monitoring}"

# Try to get password from environment
MONITORING_DB_PASSWORD="${MONITORING_DB_PASSWORD:-}"

# If password not in env, try to get from connection URL
if [[ -z "$MONITORING_DB_PASSWORD" ]] && [[ -n "${MONITORING_DB_URL:-}" ]]; then
  MONITORING_DB_PASSWORD=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$MONITORING_DB_URL'); print(unquote(url.password or ''))" 2>/dev/null || echo "")
  MONITORING_DB_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$MONITORING_DB_URL').hostname)" 2>/dev/null || echo "$MONITORING_DB_HOST")
  MONITORING_DB_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$MONITORING_DB_URL'); print(url.port or 5432)" 2>/dev/null || echo "$MONITORING_DB_PORT")
  MONITORING_DB_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$MONITORING_DB_URL'); print(unquote(url.username or ''))" 2>/dev/null || echo "$MONITORING_DB_USER")
  MONITORING_DB_NAME=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$MONITORING_DB_URL'); print(url.path.lstrip('/').split('?')[0])" 2>/dev/null || echo "$MONITORING_DB_NAME")
fi

# If still no password, prompt for it
if [[ -z "$MONITORING_DB_PASSWORD" ]]; then
  read -sp "Enter PostgreSQL password for user $MONITORING_DB_USER: " MONITORING_DB_PASSWORD
  echo ""
fi

echo "Connecting to: ${MONITORING_DB_HOST}:${MONITORING_DB_PORT}"
echo "Database: ${MONITORING_DB_NAME}"
echo "User: ${MONITORING_DB_USER}"
echo ""

# Check if database exists
echo "Step 1: Checking database connection..."
DB_EXISTS=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT 1" 2>/dev/null || echo "")

if [[ -z "$DB_EXISTS" ]] || [[ "$DB_EXISTS" != "1" ]]; then
  echo "❌ Cannot connect to database. Please check your credentials."
  exit 1
fi

echo "✓ Database connection successful"
echo ""

# Run verification schema
echo "Step 2: Creating verification tables..."
PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -f lib/db/verification-schema.sql 2>&1 | grep -v "NOTICE" || true

echo "✓ Verification tables created"
echo ""

# Verify tables
echo "Step 3: Verifying tables..."
TABLE_COUNT=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'table_verification%'")

echo "✓ Found $TABLE_COUNT verification tables"
echo ""

# List tables
echo "Verification tables created:"
PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'table_verification%' ORDER BY tablename" | while read -r table; do
  if [[ -n "$table" ]]; then
    echo "  ✓ $table"
  fi
done

echo ""
echo "========================================="
echo "✓ Verification system setup complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Start the verification worker:"
echo "     npm run verification-worker"
echo ""
echo "  2. Access the UI:"
echo "     http://localhost:3000/verification"
echo ""
echo "  3. Start a verification for a table"
echo ""
