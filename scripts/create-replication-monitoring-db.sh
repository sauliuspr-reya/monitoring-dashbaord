#!/bin/bash
set -euo pipefail

# Script to create replication_monitoring database and schema
# This sets up all tables, indexes, and views needed for the dashboard

echo "========================================="
echo "Create replication_monitoring Database"
echo "========================================="
echo ""

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

# Step 1: Create database if it doesn't exist
echo "Step 1: Creating database (if it doesn't exist)..."
DB_EXISTS=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d postgres \
  -t -A -c "SELECT 1 FROM pg_database WHERE datname = '$MONITORING_DB_NAME'" 2>/dev/null || echo "")

if [[ -z "$DB_EXISTS" ]] || [[ "$DB_EXISTS" != "1" ]]; then
  PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
    -h "$MONITORING_DB_HOST" \
    -p "$MONITORING_DB_PORT" \
    -U "$MONITORING_DB_USER" \
    -d postgres \
    -c "CREATE DATABASE $MONITORING_DB_NAME" 2>&1 | grep -v "NOTICE" || true
  echo "✓ Database created"
else
  echo "✓ Database already exists"
fi

echo ""

# Step 2: Run complete schema (includes all migrations)
echo "Step 2: Creating complete schema..."
PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -f lib/db/complete-schema.sql 2>&1 | grep -v "NOTICE" || true

echo "✓ Complete schema created"
echo ""

# Step 4: Verify tables
echo "Step 4: Verifying tables..."
TABLE_COUNT=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")

echo "✓ Found $TABLE_COUNT tables in database"
echo ""

# List all tables
echo "Tables created:"
PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" | while read -r table; do
  if [[ -n "$table" ]]; then
    echo "  ✓ $table"
  fi
done

echo ""
echo "========================================="
echo "✓ Database setup complete!"
echo "========================================="
echo ""
echo "You can now start the dashboard with:"
echo "  npm run dev"
echo ""

