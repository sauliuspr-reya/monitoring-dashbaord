#!/bin/bash
set -eo pipefail

# Run database migration to add data_copy column to subscriptions table

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$PROJECT_DIR/lib/db/migrations/005-add-data-copy-column.sql"

echo "========================================="
echo "Database Migration: Add data_copy Column"
echo "========================================="
echo ""

# Check if .env.local exists
if [[ ! -f "$PROJECT_DIR/.env.local" ]]; then
  echo "❌ Error: .env.local not found"
  echo "   Run: ./setup-env-from-secret.sh first"
  exit 1
fi

# Source environment variables (handle unset variables)
set -a
source "$PROJECT_DIR/.env.local" 2>/dev/null || true
set +a

# Check required variables
if [[ -z "${MONITORING_DB_HOST:-}" ]] || [[ -z "${MONITORING_DB_NAME:-}" ]]; then
  echo "❌ Error: MONITORING_DB_* variables not set in .env.local"
  exit 1
fi

echo "Database: ${MONITORING_DB_HOST}:${MONITORING_DB_PORT:-5432}/${MONITORING_DB_NAME}"
echo "Migration file: $MIGRATION_FILE"
echo ""

# Check if migration file exists
if [[ ! -f "$MIGRATION_FILE" ]]; then
  echo "❌ Error: Migration file not found: $MIGRATION_FILE"
  exit 1
fi

# Check current state
echo "Checking current database state..."
PGPASSWORD="${MONITORING_DB_PASSWORD}" psql \
  -h "${MONITORING_DB_HOST}" \
  -p "${MONITORING_DB_PORT:-5432}" \
  -U "${MONITORING_DB_USER:-postgres}" \
  -d "${MONITORING_DB_NAME}" \
  -c "
    SELECT 
      CASE WHEN EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_name = 'subscriptions' AND column_name = 'data_copy'
      )
        THEN 'data_copy column exists (already migrated)'
        ELSE 'data_copy column missing (needs migration)'
      END as current_state;
  " 2>&1 | grep -v "NOTICE" || true

echo ""

# Confirm
read -p "Run migration? This will add data_copy column to subscriptions table [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

echo ""
echo "Running migration..."

# Run migration
PGPASSWORD="${MONITORING_DB_PASSWORD}" psql \
  -h "${MONITORING_DB_HOST}" \
  -p "${MONITORING_DB_PORT:-5432}" \
  -U "${MONITORING_DB_USER:-postgres}" \
  -d "${MONITORING_DB_NAME}" \
  -f "$MIGRATION_FILE" \
  2>&1 | grep -v "NOTICE" || true

MIGRATION_EXIT=${PIPESTATUS[0]}

if [[ $MIGRATION_EXIT -eq 0 ]]; then
  echo ""
  echo "✓ Migration completed successfully"
  echo ""
  
  # Verify
  echo "Verifying migration..."
  PGPASSWORD="${MONITORING_DB_PASSWORD}" psql \
    -h "${MONITORING_DB_HOST}" \
    -p "${MONITORING_DB_PORT:-5432}" \
    -U "${MONITORING_DB_USER:-postgres}" \
    -d "${MONITORING_DB_NAME}" \
    -c "
      SELECT 
        CASE WHEN EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'subscriptions' AND column_name = 'data_copy'
        )
          THEN '✓ data_copy column exists'
          ELSE '❌ data_copy column missing'
        END as verification;
      
      SELECT column_name, data_type, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'subscriptions' AND column_name = 'data_copy';
    " 2>&1 | grep -v "NOTICE" || true
    
  echo ""
  echo "========================================="
  echo "✓ Migration Complete"
  echo "========================================="
else
  echo ""
  echo "⚠️  Migration completed with warnings/errors"
  echo "   Check the output above for details"
  exit 1
fi

