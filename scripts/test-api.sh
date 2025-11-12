#!/bin/bash

# Test API to see what's being returned

set -euo pipefail

echo "=========================================="
echo "Testing Dashboard API"
echo "=========================================="
echo ""

# Get auth credentials from environment or use defaults
USERNAME="${AUTH_USERNAME:-admin}"
PASSWORD="${AUTH_PASSWORD:-reyalfg}"

echo "Testing /api/tables/all..."
echo ""

RESPONSE=$(curl -s -u "$USERNAME:$PASSWORD" http://localhost:3002/api/tables/all)

# Check if response is valid JSON
if ! echo "$RESPONSE" | jq . > /dev/null 2>&1; then
  echo "❌ API returned non-JSON response:"
  echo "$RESPONSE"
  exit 1
fi

# Extract key information
TOTAL_TABLES=$(echo "$RESPONSE" | jq -r '.totalTables // 0')
MESSAGE=$(echo "$RESPONSE" | jq -r '.message // "none"')
HINT=$(echo "$RESPONSE" | jq -r '.hint // "none"')
TABLE_COUNT=$(echo "$RESPONSE" | jq -r '.tables | length')

echo "API Response Summary:"
echo "  Total Tables: $TOTAL_TABLES"
echo "  Tables Returned: $TABLE_COUNT"
echo ""

if [[ "$TOTAL_TABLES" == "0" ]]; then
  echo "❌ No tables found!"
  echo ""
  if [[ "$MESSAGE" != "none" ]]; then
    echo "Message: $MESSAGE"
  fi
  if [[ "$HINT" != "none" ]]; then
    echo "Hint: $HINT"
  fi
  echo ""
  echo "This means either:"
  echo "  1. TARGET_DATABASE_URL is not set in .env.local"
  echo "  2. TARGET_DATABASE_URL is set but connection fails"
  echo "  3. The target database has no tables"
  echo ""
  echo "Check .env.local file:"
  if grep -q "TARGET_DATABASE_URL" .env.local 2>/dev/null; then
    echo "  ✓ TARGET_DATABASE_URL is set"
    # Show first part of URL (hide password)
    URL=$(grep "TARGET_DATABASE_URL" .env.local | cut -d= -f2- | sed 's/:.*@/:***@/')
    echo "    Value: $URL"
  else
    echo "  ❌ TARGET_DATABASE_URL is NOT set"
    echo ""
    echo "Add this to .env.local:"
    echo "  TARGET_DATABASE_URL=postgresql://postgres:PASSWORD@10.107.240.2:5432/reya"
  fi
else
  echo "✓ Found $TOTAL_TABLES tables!"
  echo ""
  echo "Sample tables:"
  echo "$RESPONSE" | jq -r '.tables[0:5] | .[] | "  - \(.table) (\(.targetRowCount) rows)"'
  echo ""
  echo "Tables are available in the dashboard at http://localhost:3002/tables"
fi

echo ""
echo "=========================================="




