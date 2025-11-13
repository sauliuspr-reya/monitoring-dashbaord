#!/bin/bash
set -euo pipefail

# Restore PostgreSQL backup to GCP Cloud SQL using pg_restore
# Supports both custom format (.dump) and plain SQL files
#
# Usage:
#   ./scripts/restore-to-gcp.sh <backup-file> [options]
#
# Options:
#   --dry-run              Show what would be restored without actually restoring
#   --clean                Drop existing objects before restoring
#   --if-exists            Use IF EXISTS when dropping (safer)
#   --no-owner             Don't restore ownership (default: true)
#   --no-privileges        Don't restore privileges (default: true)
#   --tables=TABLE1,TABLE2 Restore only specific tables
#   --schema-only          Restore schema only (no data)
#   --data-only            Restore data only (no schema)
#   --jobs=N               Use N parallel jobs for restore (custom format only)
#   --verbose              Show verbose output
#
# Examples:
#   # Restore custom format dump
#   ./scripts/restore-to-gcp.sh backup_20241107_120000.dump
#
#   # Restore specific tables only
#   ./scripts/restore-to-gcp.sh backup.dump --tables=orders,items
#
#   # Restore with parallel jobs (faster for large dumps)
#   ./scripts/restore-to-gcp.sh backup.dump --jobs=4
#
#   # Restore plain SQL file
#   ./scripts/restore-to-gcp.sh backup.sql

NAMESPACE="${K8S_NAMESPACE:-postgres-replication}"
SECRET_NAME="${K8S_SECRET_NAME:-postgres-replication-secrets}"

# Parse arguments
BACKUP_FILE=""
DRY_RUN=false
CLEAN=false
IF_EXISTS=false
NO_OWNER=true
NO_PRIVILEGES=true
TABLES=""
SCHEMA_ONLY=false
DATA_ONLY=false
JOBS=1
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --clean)
      CLEAN=true
      shift
      ;;
    --if-exists)
      IF_EXISTS=true
      shift
      ;;
    --no-owner)
      NO_OWNER=true
      shift
      ;;
    --owner)
      NO_OWNER=false
      shift
      ;;
    --no-privileges)
      NO_PRIVILEGES=true
      shift
      ;;
    --privileges)
      NO_PRIVILEGES=false
      shift
      ;;
    --tables=*)
      TABLES="${1#*=}"
      shift
      ;;
    --schema-only)
      SCHEMA_ONLY=true
      shift
      ;;
    --data-only)
      DATA_ONLY=true
      shift
      ;;
    --jobs=*)
      JOBS="${1#*=}"
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --help|-h)
      cat << EOF
Restore PostgreSQL backup to GCP Cloud SQL

Usage: $0 <backup-file> [options]

Options:
  --dry-run              Show what would be restored without actually restoring
  --clean                Drop existing objects before restoring
  --if-exists            Use IF EXISTS when dropping (safer)
  --no-owner             Don't restore ownership (default: true)
  --owner                Restore ownership
  --no-privileges        Don't restore privileges (default: true)
  --privileges           Restore privileges
  --tables=TABLE1,TABLE2 Restore only specific tables
  --schema-only          Restore schema only (no data)
  --data-only            Restore data only (no schema)
  --jobs=N               Use N parallel jobs for restore (custom format only)
  --verbose              Show verbose output
  --help                 Show this help message

Examples:
  $0 backup.dump
  $0 backup.dump --tables=orders,items --jobs=4
  $0 backup.sql --clean --if-exists
EOF
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
    *)
      if [[ -z "$BACKUP_FILE" ]]; then
        BACKUP_FILE="$1"
      else
        echo "Error: Multiple backup files specified"
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Error: Backup file is required"
  echo "Usage: $0 <backup-file> [options]"
  echo "Use --help for more information"
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "❌ Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "========================================="
echo "Restore Backup to GCP Cloud SQL"
echo "========================================="
echo ""

# Detect backup format
BACKUP_FORMAT="unknown"
if [[ "$BACKUP_FILE" == *.dump ]] || [[ "$BACKUP_FILE" == *.backup ]]; then
  BACKUP_FORMAT="custom"
  echo "✓ Detected custom format backup"
elif [[ "$BACKUP_FILE" == *.sql ]] || [[ "$BACKUP_FILE" == *.sql.gz ]]; then
  BACKUP_FORMAT="plain"
  echo "✓ Detected plain SQL backup"
else
  # Try to detect by file header
  if file "$BACKUP_FILE" | grep -q "PostgreSQL custom database dump"; then
    BACKUP_FORMAT="custom"
    echo "✓ Detected custom format backup (by file header)"
  elif head -c 100 "$BACKUP_FILE" | grep -q "^-- PostgreSQL database dump"; then
    BACKUP_FORMAT="plain"
    echo "✓ Detected plain SQL backup (by file header)"
  else
    echo "⚠️  Warning: Could not detect backup format, assuming plain SQL"
    BACKUP_FORMAT="plain"
  fi
fi

# Get GCP connection details
echo ""
echo "Reading GCP Cloud SQL connection details..."

if kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" &>/dev/null; then
  echo "✓ Found Kubernetes secret: $NAMESPACE/$SECRET_NAME"
  DEST_URL=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o jsonpath='{.data.target-database-url}' | base64 -d)
else
  echo "⚠️  Kubernetes secret not found, trying environment variable..."
  if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
    echo "❌ Error: TARGET_DATABASE_URL environment variable not set"
    echo "   Either set TARGET_DATABASE_URL or ensure K8s secret exists"
    exit 1
  fi
  DEST_URL="$TARGET_DATABASE_URL"
fi

# Parse connection string
DEST_HOST=$(python3 -c "from urllib.parse import urlparse; print(urlparse('$DEST_URL').hostname)" 2>/dev/null || echo "")
DEST_PORT=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.port or 5432)" 2>/dev/null || echo "5432")
DEST_USER=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.username or ''))" 2>/dev/null || echo "")
DEST_PASS=$(python3 -c "from urllib.parse import urlparse, unquote; url = urlparse('$DEST_URL'); print(unquote(url.password or ''))" 2>/dev/null || echo "")
DEST_DB=$(python3 -c "from urllib.parse import urlparse; url = urlparse('$DEST_URL'); print(url.path.lstrip('/').split('?')[0])" 2>/dev/null || echo "")

if [[ -z "$DEST_HOST" ]] || [[ -z "$DEST_USER" ]] || [[ -z "$DEST_DB" ]]; then
  echo "❌ Error: Failed to parse connection string"
  echo "   Host: ${DEST_HOST:-empty}"
  echo "   User: ${DEST_USER:-empty}"
  echo "   Database: ${DEST_DB:-empty}"
  exit 1
fi

echo "✓ Connection details parsed"
echo ""
echo "Target:  ${DEST_HOST}:${DEST_PORT}/${DEST_DB}"
echo "User:    ${DEST_USER}"
echo "File:    $BACKUP_FILE"
echo "Format:  $BACKUP_FORMAT"
echo ""

# Build restore command
RESTORE_CMD=""

if [[ "$BACKUP_FORMAT" == "custom" ]]; then
  # Use pg_restore for custom format
  RESTORE_CMD="pg_restore"
  
  RESTORE_ARGS=(
    "-h" "$DEST_HOST"
    "-p" "$DEST_PORT"
    "-U" "$DEST_USER"
    "-d" "$DEST_DB"
  )
  
  if [[ "$NO_OWNER" == "true" ]]; then
    RESTORE_ARGS+=("--no-owner")
  fi
  
  if [[ "$NO_PRIVILEGES" == "true" ]]; then
    RESTORE_ARGS+=("--no-privileges")
  fi
  
  if [[ "$CLEAN" == "true" ]]; then
    RESTORE_ARGS+=("--clean")
  fi
  
  if [[ "$IF_EXISTS" == "true" ]]; then
    RESTORE_ARGS+=("--if-exists")
  fi
  
  if [[ "$SCHEMA_ONLY" == "true" ]]; then
    RESTORE_ARGS+=("--schema-only")
  fi
  
  if [[ "$DATA_ONLY" == "true" ]]; then
    RESTORE_ARGS+=("--data-only")
  fi
  
  if [[ -n "$TABLES" ]]; then
    IFS=',' read -ra TABLE_ARRAY <<< "$TABLES"
    for table in "${TABLE_ARRAY[@]}"; do
      RESTORE_ARGS+=("-t" "$table")
    done
  fi
  
  if [[ "$JOBS" -gt 1 ]]; then
    RESTORE_ARGS+=("--jobs=$JOBS")
  fi
  
  if [[ "$VERBOSE" == "true" ]]; then
    RESTORE_ARGS+=("--verbose")
  fi
  
  RESTORE_ARGS+=("$BACKUP_FILE")
  
else
  # Use psql for plain SQL files
  RESTORE_CMD="psql"
  
  RESTORE_ARGS=(
    "-h" "$DEST_HOST"
    "-p" "$DEST_PORT"
    "-U" "$DEST_USER"
    "-d" "$DEST_DB"
  )
  
  if [[ "$VERBOSE" == "true" ]]; then
    RESTORE_ARGS+=("-v" "ON_ERROR_STOP=1")
  else
    RESTORE_ARGS+=("-q")  # Quiet mode
  fi
  
  # Handle compressed SQL files
  if [[ "$BACKUP_FILE" == *.gz ]]; then
    RESTORE_ARGS+=("-f" "-")
    RESTORE_CMD="gunzip -c '$BACKUP_FILE' | $RESTORE_CMD"
  else
    RESTORE_ARGS+=("-f" "$BACKUP_FILE")
  fi
fi

# Show what will be executed
echo "Command to execute:"
if [[ "$BACKUP_FORMAT" == "custom" ]]; then
  echo "  PGPASSWORD='***' $RESTORE_CMD ${RESTORE_ARGS[*]}"
else
  if [[ "$BACKUP_FILE" == *.gz ]]; then
    echo "  PGPASSWORD='***' gunzip -c '$BACKUP_FILE' | $RESTORE_CMD ${RESTORE_ARGS[*]}"
  else
    echo "  PGPASSWORD='***' $RESTORE_CMD ${RESTORE_ARGS[*]}"
  fi
fi
echo ""

# Show options
echo "Options:"
echo "  Clean:        $CLEAN"
echo "  If Exists:    $IF_EXISTS"
echo "  No Owner:    $NO_OWNER"
echo "  No Privileges: $NO_PRIVILEGES"
if [[ -n "$TABLES" ]]; then
  echo "  Tables:      $TABLES"
fi
if [[ "$SCHEMA_ONLY" == "true" ]]; then
  echo "  Schema Only: true"
fi
if [[ "$DATA_ONLY" == "true" ]]; then
  echo "  Data Only:   true"
fi
if [[ "$BACKUP_FORMAT" == "custom" ]] && [[ "$JOBS" -gt 1 ]]; then
  echo "  Parallel Jobs: $JOBS"
fi
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  echo "DRY RUN: Would restore backup to GCP Cloud SQL"
  echo "To actually restore, run without --dry-run flag"
  exit 0
fi

# Confirm
read -p "Restore backup to GCP Cloud SQL? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

echo ""
echo "Restoring backup..."

# Execute restore
set +e  # Don't exit on error, we'll check status

if [[ "$BACKUP_FORMAT" == "custom" ]]; then
  # Custom format: use pg_restore
  export PGPASSWORD="$DEST_PASS"
  
  if [[ "$VERBOSE" == "true" ]]; then
    pg_restore "${RESTORE_ARGS[@]}" 2>&1 | tee /tmp/restore_output.log
  else
    pg_restore "${RESTORE_ARGS[@]}" 2>&1 | grep -v "NOTICE" | tee /tmp/restore_output.log
  fi
  
  RESTORE_EXIT_CODE=${PIPESTATUS[0]}
  
else
  # Plain SQL: use psql
  export PGPASSWORD="$DEST_PASS"
  
  if [[ "$BACKUP_FILE" == *.gz ]]; then
    # Compressed SQL file
    gunzip -c "$BACKUP_FILE" | psql "${RESTORE_ARGS[@]}" 2>&1 | tee /tmp/restore_output.log
    RESTORE_EXIT_CODE=${PIPESTATUS[1]}  # Check psql exit code, not gunzip
  else
    # Plain SQL file
    psql "${RESTORE_ARGS[@]}" 2>&1 | grep -v "NOTICE" | tee /tmp/restore_output.log
    RESTORE_EXIT_CODE=${PIPESTATUS[0]}
  fi
fi

set -e  # Re-enable exit on error

# Check result
if [[ $RESTORE_EXIT_CODE -eq 0 ]]; then
  echo ""
  echo "✓ Backup restored successfully"
  
  # Show summary if verbose
  if [[ "$VERBOSE" == "true" ]]; then
    echo ""
    echo "Restore summary:"
    if [[ "$BACKUP_FORMAT" == "custom" ]]; then
      echo "  Format: Custom (pg_restore)"
    else
      echo "  Format: Plain SQL (psql)"
    fi
    if [[ -n "$TABLES" ]]; then
      echo "  Tables restored: $TABLES"
    fi
  fi
else
  echo ""
  echo "❌ Restore failed with exit code: $RESTORE_EXIT_CODE"
  echo ""
  echo "Last 20 lines of output:"
  tail -n 20 /tmp/restore_output.log
  echo ""
  echo "Full output saved to: /tmp/restore_output.log"
  exit $RESTORE_EXIT_CODE
fi

echo ""
echo "========================================="
echo "✓ Done"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Verify restored data: psql -h $DEST_HOST -U $DEST_USER -d $DEST_DB -c '\\dt'"
if [[ "$SCHEMA_ONLY" == "true" ]]; then
  echo "  2. Restore data separately if needed"
else
  echo "  2. Check replication status if using subscriptions"
fi

