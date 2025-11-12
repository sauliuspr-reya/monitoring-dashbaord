#!/bin/bash
set -eo pipefail

# Run database migration to rename replication_groups to subscriptions

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$PROJECT_DIR/lib/db/migrations/001-rename-groups-to-subscriptions.sql"

echo "========================================="
echo "Database Migration: Rename Groups to Subscriptions"
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
      CASE WHEN EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'replication_groups')
        THEN 'replication_groups (needs migration)'
        ELSE 'subscriptions (already migrated)'
      END as current_state;
  " 2>&1 | grep -v "NOTICE" || true

echo ""

# Confirm
read -p "Run migration? This will rename replication_groups to subscriptions [y/N]: " confirm
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
        CASE WHEN EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'subscriptions')
          THEN '✓ subscriptions table exists'
          ELSE '❌ subscriptions table missing'
        END as verification;
      
      SELECT COUNT(*) as subscription_count FROM subscriptions;
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

