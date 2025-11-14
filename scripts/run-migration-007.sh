#!/bin/bash
set -eo pipefail

# Run migration 007: Add task logs support
# Usage: ./scripts/run-migration-007.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$PROJECT_DIR/lib/db/migrations/007-add-task-logs.sql"

echo "========================================="
echo "Database Migration: Add Task Logs Support"
echo "========================================="
echo ""

# Check if .env.local exists
if [[ -f "$PROJECT_DIR/.env.local" ]]; then
  echo "Loading environment from .env.local..."
  set -a
  source "$PROJECT_DIR/.env.local" 2>/dev/null || true
  set +a
fi

# Check required variables (use MONITORING_DB_* variables like other migration scripts)
if [[ -z "${MONITORING_DB_HOST:-}" ]] || [[ -z "${MONITORING_DB_NAME:-}" ]]; then
  echo "❌ Error: MONITORING_DB_* variables not set in .env.local"
  echo ""
  echo "Required variables:"
  echo "  MONITORING_DB_HOST"
  echo "  MONITORING_DB_NAME (should be 'replication_monitoring')"
  echo "  MONITORING_DB_USER (defaults to 'postgres')"
  echo "  MONITORING_DB_PASSWORD"
  echo "  MONITORING_DB_PORT (defaults to 5432)"
  exit 1
fi

MONITORING_DB_PORT="${MONITORING_DB_PORT:-5432}"
MONITORING_DB_USER="${MONITORING_DB_USER:-postgres}"

# Check if migration file exists
if [[ ! -f "$MIGRATION_FILE" ]]; then
  echo "❌ Error: Migration file not found: $MIGRATION_FILE"
  exit 1
fi

echo "Migration file: $MIGRATION_FILE"
echo "Database: ${MONITORING_DB_HOST}:${MONITORING_DB_PORT}/${MONITORING_DB_NAME}"
echo "User: ${MONITORING_DB_USER}"
echo ""

# Confirm
read -p "Run migration 007 (Add task logs support)? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

echo ""
echo "Running migration..."

# Run migration using individual connection parameters
PGPASSWORD="${MONITORING_DB_PASSWORD}" psql \
  -h "${MONITORING_DB_HOST}" \
  -p "${MONITORING_DB_PORT}" \
  -U "${MONITORING_DB_USER}" \
  -d "${MONITORING_DB_NAME}" \
  -f "$MIGRATION_FILE" \
  2>&1 | grep -v "NOTICE" || true

MIGRATION_EXIT=${PIPESTATUS[0]}

if [[ $MIGRATION_EXIT -eq 0 ]]; then
  echo ""
  echo "✅ Migration 007 completed successfully"
  echo ""
  
  # Verify
  echo "Verifying migration..."
  PGPASSWORD="${MONITORING_DB_PASSWORD}" psql \
    -h "${MONITORING_DB_HOST}" \
    -p "${MONITORING_DB_PORT}" \
    -U "${MONITORING_DB_USER}" \
    -d "${MONITORING_DB_NAME}" \
    -c "
    SELECT 
      CASE WHEN EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'task_logs')
        THEN '✓ task_logs table exists'
        ELSE '❌ task_logs table missing'
      END as verification;
    
    SELECT 
      CASE WHEN EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_name = 'backup_tasks' AND column_name = 'log_filepath'
      )
        THEN '✓ backup_tasks.log_filepath column exists'
        ELSE '❌ backup_tasks.log_filepath column missing'
      END as verification2;
  " 2>&1 | grep -v "NOTICE" || true
  
  echo ""
  echo "========================================="
  echo "✅ Migration Complete"
  echo "========================================="
else
  echo ""
  echo "❌ Migration failed"
  echo "   Check the output above for details"
  exit 1
fi

