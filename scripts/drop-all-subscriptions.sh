#!/bin/bash
set -euo pipefail

# Drop all PostgreSQL subscriptions to allow database cleanup
# This removes all logical replication subscriptions from the target database

echo "========================================="
echo "Dropping All Replication Subscriptions"
echo "========================================="
echo ""

# Load environment from .env.local
if [[ ! -f .env.local ]]; then
  echo "❌ Error: .env.local not found"
  exit 1
fi

# Read .env.local
TARGET_DATABASE_URL=$(grep "^DESTINATION_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')

if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  TARGET_DATABASE_URL=$(grep "^TARGET_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g' || echo "")
fi

if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  echo "❌ Error: DESTINATION_DATABASE_URL not found in .env.local"
  exit 1
fi

# Parse target database connection from URL
TARGET_DB_HOST=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*@\([^:\/]*\).*/\1/p')
TARGET_DB_PORT=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*:\([0-9]*\)\/.*/\1/p' || echo "5432")
TARGET_DB_NAME=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p')
TARGET_DB_USER=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*\/\/\([^:]*\):.*/\1/p')
TARGET_DB_PASSWORD=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p' | sed 's/\\//g' | sed 's/%24/$/g' | sed 's/%3D/=/g')

echo "✓ Environment loaded"
echo ""
echo "Target Database: ${TARGET_DB_HOST}/${TARGET_DB_NAME}"
echo ""

# Get all subscriptions
echo "Fetching subscriptions from PostgreSQL..."
SUBSCRIPTIONS=$(PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -t -A -c "
  SELECT subname
  FROM pg_subscription
  ORDER BY subname
")

if [[ -z "$SUBSCRIPTIONS" ]]; then
  echo "✓ No subscriptions found - nothing to drop"
  exit 0
fi

TOTAL=0
DROPPED=0
ERRORS=0

echo "Found subscriptions to drop:"
echo ""

# Count subscriptions
TOTAL=$(echo "$SUBSCRIPTIONS" | grep -c . || echo 0)

echo "⚠️  WARNING: This will drop $TOTAL subscription(s)!"
echo ""
read -p "Are you sure you want to proceed? [y/N]: " confirm
echo ""

if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

while IFS= read -r SUBNAME; do
  if [[ -z "$SUBNAME" ]]; then
    continue
  fi
  
  echo "📦 Dropping: ${SUBNAME}"
  
  # First disable the subscription
  DISABLE_RESULT=$(PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -t -A -c "
    ALTER SUBSCRIPTION \"${SUBNAME}\" DISABLE;
  " 2>&1 || echo "ERROR")
  
  if [[ "$DISABLE_RESULT" == *"ERROR"* ]]; then
    echo "   ⚠️  Warning: Could not disable subscription (may already be disabled)"
  else
    echo "   ✓ Disabled"
  fi
  
  # Drop the subscription (this will also drop the replication slot)
  DROP_RESULT=$(PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -t -A -c "
    DROP SUBSCRIPTION IF EXISTS \"${SUBNAME}\";
  " 2>&1 || echo "ERROR")
  
  if [[ "$DROP_RESULT" == *"ERROR"* ]]; then
    echo "   ❌ Error dropping subscription"
    ERRORS=$((ERRORS + 1))
  else
    echo "   ✅ Dropped"
    DROPPED=$((DROPPED + 1))
  fi
  
  echo ""
done <<< "$SUBSCRIPTIONS"

echo "========================================="
echo "Summary"
echo "========================================="
echo "Total subscriptions found: ${TOTAL}"
echo "Dropped: ${DROPPED}"
echo "Errors: ${ERRORS}"
echo ""

if [[ $DROPPED -eq $TOTAL ]]; then
  echo "✓ All subscriptions dropped successfully!"
  echo ""
  echo "You can now drop the database with:"
  echo "  psql -h $TARGET_DB_HOST -U $TARGET_DB_USER -d postgres -c 'DROP DATABASE IF EXISTS ${TARGET_DB_NAME};'"
else
  echo "⚠️  Some subscriptions could not be dropped. Check errors above."
fi
echo ""
