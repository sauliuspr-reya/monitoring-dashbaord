#!/bin/bash
set -euo pipefail

# Cleanup script for Data Integrity Verification System
# This script removes all data from verification tables for a clean start

echo "========================================="
echo "Cleanup Verification System"
echo "========================================="
echo ""
echo "⚠️  WARNING: This will delete ALL verification data!"
echo "   - All verification jobs"
echo "   - All mismatches"
echo "   - All gaps"
echo ""
read -p "Are you sure you want to continue? (yes/no): " CONFIRM

if [[ "$CONFIRM" != "yes" ]]; then
  echo "Cleanup cancelled."
  exit 0
fi

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

# Get counts before cleanup
echo "Step 2: Checking current data..."
JOBS_COUNT=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT COUNT(*) FROM table_verification_jobs" 2>/dev/null || echo "0")

MISMATCHES_COUNT=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT COUNT(*) FROM table_verification_mismatches" 2>/dev/null || echo "0")

GAPS_COUNT=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT COUNT(*) FROM table_verification_gaps" 2>/dev/null || echo "0")

echo "Current data:"
echo "  - Verification jobs: $JOBS_COUNT"
echo "  - Mismatches: $MISMATCHES_COUNT"
echo "  - Gaps: $GAPS_COUNT"
echo ""

if [[ "$JOBS_COUNT" == "0" ]] && [[ "$MISMATCHES_COUNT" == "0" ]] && [[ "$GAPS_COUNT" == "0" ]]; then
  echo "✓ No data to cleanup. Tables are already empty."
  echo ""
  echo "========================================="
  echo "✓ Done"
  echo "========================================="
  exit 0
fi

# Perform cleanup
echo "Step 3: Cleaning up verification data..."

# Delete in correct order (CASCADE will handle it, but being explicit)
PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -c "TRUNCATE TABLE table_verification_gaps, table_verification_mismatches, table_verification_jobs RESTART IDENTITY CASCADE;" \
  2>&1 | grep -v "NOTICE" || true

echo "✓ Verification data cleaned up"
echo ""

# Verify cleanup
echo "Step 4: Verifying cleanup..."
JOBS_AFTER=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT COUNT(*) FROM table_verification_jobs" 2>/dev/null || echo "0")

MISMATCHES_AFTER=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT COUNT(*) FROM table_verification_mismatches" 2>/dev/null || echo "0")

GAPS_AFTER=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql \
  -h "$MONITORING_DB_HOST" \
  -p "$MONITORING_DB_PORT" \
  -U "$MONITORING_DB_USER" \
  -d "$MONITORING_DB_NAME" \
  -t -A -c "SELECT COUNT(*) FROM table_verification_gaps" 2>/dev/null || echo "0")

if [[ "$JOBS_AFTER" == "0" ]] && [[ "$MISMATCHES_AFTER" == "0" ]] && [[ "$GAPS_AFTER" == "0" ]]; then
  echo "✓ All verification data removed"
  echo ""
  echo "Deleted:"
  echo "  - $JOBS_COUNT verification jobs"
  echo "  - $MISMATCHES_COUNT mismatches"
  echo "  - $GAPS_COUNT gaps"
else
  echo "⚠️  Warning: Some data may remain"
  echo "  - Jobs: $JOBS_AFTER"
  echo "  - Mismatches: $MISMATCHES_AFTER"
  echo "  - Gaps: $GAPS_AFTER"
fi

echo ""
echo "========================================="
echo "✓ Cleanup complete!"
echo "========================================="
echo ""
echo "You can now start fresh verification jobs."
echo ""
