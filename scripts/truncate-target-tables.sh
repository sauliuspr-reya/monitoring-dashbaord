#!/bin/bash

# Script to truncate all tables on the target database
# This is useful for resetting the target database before restoring or setting up replication

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================="
echo "Truncate All Tables on Target Database"
echo "========================================="
echo ""

# Get target database connection from environment variable
# Priority: TARGET_DATABASE_URL > Kubernetes secret
TARGET_DB_URL="${TARGET_DATABASE_URL}"

if [ -z "$TARGET_DB_URL" ]; then
  # Try to get from Kubernetes secret
  if command -v kubectl &> /dev/null; then
    echo "TARGET_DATABASE_URL not set, attempting to get from Kubernetes secret..."
    TARGET_DB_URL=$(kubectl get secret target-database-url -n postgres-replication -o jsonpath='{.data.url}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
    
    # Also try the standard secret name
    if [ -z "$TARGET_DB_URL" ]; then
      TARGET_DB_URL=$(kubectl get secret postgres-replication-secrets -n postgres-replication -o jsonpath='{.data.target-database-url}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
    fi
  fi
fi

if [ -z "$TARGET_DB_URL" ]; then
  echo -e "${RED}Error: TARGET_DATABASE_URL environment variable is not set${NC}"
  echo ""
  echo "Please set it:"
  echo "  export TARGET_DATABASE_URL='postgresql://user:password@host:port/database'"
  echo ""
  echo "Or ensure kubectl can access the secret:"
  echo "  kubectl get secret target-database-url -n postgres-replication"
  exit 1
fi

# Parse connection string (more robust parsing)
# Remove protocol if present
DB_URL_NO_PROTO=$(echo "$TARGET_DB_URL" | sed 's|^postgresql://||;s|^postgres://||')

# Extract user (everything before first colon)
TARGET_USER=$(echo "$DB_URL_NO_PROTO" | cut -d: -f1)

# Extract password (between first colon and @)
TARGET_PASS_RAW=$(echo "$DB_URL_NO_PROTO" | sed -n 's/^[^:]*:\([^@]*\)@.*/\1/p')

# Extract host and port (between @ and /)
HOST_PORT=$(echo "$DB_URL_NO_PROTO" | sed -n 's/.*@\([^/]*\)\/.*/\1/p')
TARGET_HOST=$(echo "$HOST_PORT" | cut -d: -f1)
TARGET_PORT=$(echo "$HOST_PORT" | cut -d: -f2)

# Extract database (after last /, before ?)
TARGET_DB=$(echo "$DB_URL_NO_PROTO" | sed -n 's/.*\/\([^?]*\).*/\1/p')

# URL decode password (handle % encoding)
TARGET_PASS=$(printf '%b\n' "${TARGET_PASS_RAW//%/\\x}")

if [ -z "$TARGET_HOST" ] || [ -z "$TARGET_USER" ] || [ -z "$TARGET_DB" ]; then
  echo -e "${RED}Error: Could not parse TARGET_DATABASE_URL${NC}"
  exit 1
fi

TARGET_PORT=${TARGET_PORT:-5432}

echo "Target Database:"
echo "  Host: $TARGET_HOST"
echo "  Port: $TARGET_PORT"
echo "  Database: $TARGET_DB"
echo "  User: $TARGET_USER"
echo ""

# Confirm before proceeding
read -p "⚠️  WARNING: This will TRUNCATE ALL TABLES in the target database. This action cannot be undone! Continue? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

echo ""
echo "Fetching list of tables..."

# Get list of all tables (excluding system tables)
# Use quote_ident to properly quote table names with mixed case
export PGPASSWORD="$TARGET_PASS"
TABLES=$(psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -t -c "
  SELECT quote_ident(schemaname)||'.'||quote_ident(tablename) 
  FROM pg_tables 
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  ORDER BY schemaname, tablename;
" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')

if [ -z "$TABLES" ]; then
  echo -e "${YELLOW}No tables found to truncate${NC}"
  exit 0
fi

TABLE_COUNT=$(echo "$TABLES" | wc -l | tr -d ' ')
echo "Found $TABLE_COUNT table(s) to truncate"
echo ""

# Show tables that will be truncated
echo "Tables to truncate:"
echo "$TABLES" | head -20
if [ "$TABLE_COUNT" -gt 20 ]; then
  echo "... and $((TABLE_COUNT - 20)) more"
fi
echo ""

# Final confirmation
read -p "Proceed with truncating all $TABLE_COUNT table(s)? [y/N]: " confirm2
if [[ ! "$confirm2" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

echo ""
echo "Truncating tables..."

# Truncate all tables with CASCADE to handle foreign keys
SUCCESS_COUNT=0
FAILED_COUNT=0
FAILED_TABLES=()

while IFS= read -r table; do
  if [ -z "$table" ]; then
    continue
  fi
  
  # Table name is already properly quoted by quote_ident, so use it directly
  # Execute truncate with error output captured
  ERROR_OUTPUT=$(psql -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" -c "TRUNCATE TABLE $table CASCADE;" 2>&1)
  EXIT_CODE=$?
  
  if [ $EXIT_CODE -eq 0 ]; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    echo -e "${GREEN}✓${NC} Truncated: $table"
  else
    FAILED_COUNT=$((FAILED_COUNT + 1))
    FAILED_TABLES+=("$table")
    echo -e "${RED}✗${NC} Failed: $table"
    # Show error message if verbose
    if [ -n "$ERROR_OUTPUT" ]; then
      echo "    Error: $(echo "$ERROR_OUTPUT" | head -1)"
    fi
  fi
done <<< "$TABLES"

echo ""
echo "========================================="
echo "Summary:"
echo "  Successfully truncated: $SUCCESS_COUNT table(s)"
echo "  Failed: $FAILED_COUNT table(s)"
echo "========================================="

if [ "$FAILED_COUNT" -gt 0 ]; then
  echo ""
  echo -e "${RED}Failed tables:${NC}"
  for table in "${FAILED_TABLES[@]}"; do
    echo "  - $table"
  done
  exit 1
fi

echo ""
echo -e "${GREEN}✓ All tables truncated successfully${NC}"

