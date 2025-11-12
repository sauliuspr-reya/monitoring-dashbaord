#!/bin/bash
set -euo pipefail

# Import existing PostgreSQL subscriptions into the monitoring database
# This discovers all subscriptions from pg_subscription and adds them to the dashboard

echo "========================================="
echo "Importing Existing Subscriptions"
echo "========================================="
echo ""

# Load environment from .env.local
if [[ ! -f .env.local ]]; then
  echo "❌ Error: .env.local not found"
  exit 1
fi

# Read .env.local
MONITORING_DB_HOST=$(grep "^MONITORING_DB_HOST=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'")
MONITORING_DB_PORT=$(grep "^MONITORING_DB_PORT=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" || echo "5432")
MONITORING_DB_NAME=$(grep "^MONITORING_DB_NAME=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" || echo "replication_monitoring")
MONITORING_DB_USER=$(grep "^MONITORING_DB_USER=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'")
MONITORING_DB_PASSWORD=$(grep "^MONITORING_DB_PASSWORD=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')

SOURCE_DATABASE_URL=$(grep "^SOURCE_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')
TARGET_DATABASE_URL=$(grep "^DESTINATION_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')

if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  TARGET_DATABASE_URL=$(grep "^TARGET_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g' || echo "")
fi

if [[ -z "${MONITORING_DB_HOST:-}" ]] || [[ -z "${SOURCE_DATABASE_URL:-}" ]] || [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  echo "❌ Error: Missing required environment variables in .env.local"
  echo "   Required: MONITORING_DB_HOST, SOURCE_DATABASE_URL, DESTINATION_DATABASE_URL (or TARGET_DATABASE_URL)"
  exit 1
fi

echo "✓ Environment loaded"
echo ""

# Parse target database connection from URL
TARGET_DB_HOST=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*@\([^:\/]*\).*/\1/p')
TARGET_DB_PORT=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*:\([0-9]*\)\/.*/\1/p' || echo "5432")
TARGET_DB_NAME=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p')
TARGET_DB_USER=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*\/\/\([^:]*\):.*/\1/p')
TARGET_DB_PASSWORD=$(echo "$TARGET_DATABASE_URL" | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p' | sed 's/\\//g' | sed 's/%24/$/g' | sed 's/%3D/=/g')

echo "Connecting to target database: ${TARGET_DB_HOST}/${TARGET_DB_NAME}"
echo "Connecting to monitoring database: ${MONITORING_DB_HOST}/${MONITORING_DB_NAME}"
echo ""

# Get all subscriptions from target database
echo "Fetching subscriptions from PostgreSQL..."
SUBSCRIPTIONS=$(PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -t -A -F $'\t' -c "
  SELECT 
    subname,
    subpublications[1] as publication,
    subslotname,
    subenabled
  FROM pg_subscription
  ORDER BY subname
")

if [[ -z "$SUBSCRIPTIONS" ]]; then
  echo "❌ No subscriptions found in target database"
  exit 1
fi

TOTAL=0
IMPORTED=0
SKIPPED=0
ERRORS=0

echo ""
echo "Found subscriptions:"
echo ""

while IFS=$'\t' read -r SUBNAME PUBLICATION SLOT ENABLED; do
  if [[ -z "$SUBNAME" ]]; then
    continue
  fi
  
  # Convert PostgreSQL boolean (t/f) to SQL boolean (true/false)
  if [[ "$ENABLED" == "t" ]]; then
    ENABLED="true"
  else
    ENABLED="false"
  fi
  
  TOTAL=$((TOTAL + 1))
  
  echo "📦 ${SUBNAME}"
  echo "   Publication: ${PUBLICATION}"
  echo "   Slot: ${SLOT}"
  echo "   Enabled: ${ENABLED}"
  
  # Check if already exists
  EXISTING=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql -h "$MONITORING_DB_HOST" -p "$MONITORING_DB_PORT" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" -t -A -c "
    SELECT COUNT(*) FROM subscriptions WHERE name = '${SUBNAME}'
  " 2>/dev/null || echo "0")
  
  if [[ "$EXISTING" == "1" ]]; then
    echo "   ⏭️  Already exists, skipping"
    SKIPPED=$((SKIPPED + 1))
  else
    # Insert into monitoring database using a temp SQL file to handle special characters
    TEMP_SQL=$(mktemp)
    cat > "$TEMP_SQL" <<SQL_EOF
INSERT INTO subscriptions (
  name,
  description,
  source_db_connection,
  target_db_connection,
  publication_name,
  subscription_name,
  slot_name,
  enabled
) VALUES (
  '${SUBNAME}',
  'Auto-imported from PostgreSQL subscription ${SUBNAME}',
  '${SOURCE_DATABASE_URL}',
  '${TARGET_DATABASE_URL}',
  '${PUBLICATION}',
  '${SUBNAME}',
  '${SLOT}',
  ${ENABLED}
);
SQL_EOF
    
    RESULT=$(PGPASSWORD="$MONITORING_DB_PASSWORD" psql -h "$MONITORING_DB_HOST" -p "$MONITORING_DB_PORT" -U "$MONITORING_DB_USER" -d "$MONITORING_DB_NAME" -t -A -f "$TEMP_SQL" 2>&1 || echo "ERROR")
    rm -f "$TEMP_SQL"
    
    if [[ "$RESULT" == "ERROR" ]] || [[ -z "$RESULT" ]]; then
      echo "   ❌ Error importing"
      ERRORS=$((ERRORS + 1))
    else
      echo "   ✅ Imported"
      IMPORTED=$((IMPORTED + 1))
    fi
  fi
  
  echo ""
done <<< "$SUBSCRIPTIONS"

echo "========================================="
echo "Summary"
echo "========================================="
echo "Total subscriptions found: ${TOTAL}"
echo "Imported: ${IMPORTED}"
echo "Skipped (already exist): ${SKIPPED}"
echo "Errors: ${ERRORS}"
echo ""
echo "✓ Import complete!"
PORT="${PORT:-3000}"
echo "View at: http://localhost:${PORT}/subscriptions"
echo ""
