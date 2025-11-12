#!/bin/bash
set -euo pipefail

# Reset and rebuild all subscriptions with correct table grouping
# This script will:
# 1. Drop all existing subscriptions
# 2. Drop all existing publications
# 3. Recreate subscriptions with no duplicate tables

echo "=============================================="
echo "Reset and Rebuild Subscriptions"
echo "=============================================="
echo ""
echo "This will:"
echo "  1. Drop all existing subscriptions"
echo "  2. Drop all existing publications"
echo "  3. Recreate 4 subscriptions with no duplicates"
echo ""
read -p "Continue? [y/N]: " confirm
echo ""

if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

# Load environment
if [[ ! -f .env.local ]]; then
  echo "❌ Error: .env.local not found"
  exit 1
fi

SOURCE_DATABASE_URL=$(grep "^SOURCE_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')
TARGET_DATABASE_URL=$(grep "^DESTINATION_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')

if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  TARGET_DATABASE_URL=$(grep "^TARGET_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g' || echo "")
fi

# Parse connection details
SOURCE_DB_HOST=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*@\([^:\/]*\).*/\1/p')
SOURCE_DB_PORT=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*:\([0-9]*\)\/.*/\1/p' || echo "5432")
SOURCE_DB_NAME=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p')
SOURCE_DB_USER=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*\/\/\([^:]*\):.*/\1/p')
SOURCE_DB_PASSWORD=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p' | sed 's/\\//g' | sed 's/%24/$/g' | sed 's/%3D/=/g')

TARGET_DB_HOST=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*@\([^:\/]*\).*/\1/p')
TARGET_DB_PORT=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*:\([0-9]*\)\/.*/\1/p' || echo "5432")
TARGET_DB_NAME=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p')
TARGET_DB_USER=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*\/\/\([^:]*\):.*/\1/p')
TARGET_DB_PASSWORD=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p' | sed 's/\\//g' | sed 's/%24/$/g' | sed 's/%3D/=/g')

echo "Source: ${SOURCE_DB_HOST}/${SOURCE_DB_NAME}"
echo "Target: ${TARGET_DB_HOST}/${TARGET_DB_NAME}"
echo ""

# Step 1: Drop all subscriptions
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 1: Dropping existing subscriptions"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SUBSCRIPTIONS=$(PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -t -A -c "
  SELECT subname FROM pg_subscription ORDER BY subname
" || echo "")

if [[ -n "$SUBSCRIPTIONS" ]]; then
  while IFS= read -r SUBNAME; do
    if [[ -z "$SUBNAME" ]]; then
      continue
    fi
    echo "Dropping subscription: ${SUBNAME}"
    PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -c "
      ALTER SUBSCRIPTION \"${SUBNAME}\" DISABLE;
      DROP SUBSCRIPTION IF EXISTS \"${SUBNAME}\";
    " > /dev/null 2>&1 || true
    echo "  ✅ Dropped"
  done <<< "$SUBSCRIPTIONS"
else
  echo "No subscriptions to drop"
fi
echo ""

# Step 2: Drop all publications
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 2: Dropping existing publications"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PUBLICATIONS=$(PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "
  SELECT pubname FROM pg_publication WHERE pubname LIKE 'pub_app_%' ORDER BY pubname
" || echo "")

if [[ -n "$PUBLICATIONS" ]]; then
  while IFS= read -r PUBNAME; do
    if [[ -z "$PUBNAME" ]]; then
      continue
    fi
    echo "Dropping publication: ${PUBNAME}"
    PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -c "
      DROP PUBLICATION IF EXISTS ${PUBNAME};
    " > /dev/null 2>&1 || true
    echo "  ✅ Dropped"
  done <<< "$PUBLICATIONS"
else
  echo "No publications to drop"
fi
echo ""

# Step 3: Recreate subscriptions
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 3: Recreating subscriptions"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Running: ./scripts/setup-grouped-subscriptions.sh"
echo ""

# Run the setup script non-interactively
echo "y" | ./scripts/setup-grouped-subscriptions.sh

echo ""
echo "=============================================="
echo "✅ Reset Complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo "1. Import to dashboard:"
echo "   ./scripts/import-existing-subscriptions.sh"
echo ""
echo "2. Monitor progress:"
echo "   http://localhost:3002/subscriptions"
echo ""
