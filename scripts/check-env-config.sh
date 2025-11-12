#!/bin/bash

# Quick Environment Configuration Check
# Verifies that .env.local is properly configured

set -euo pipefail

echo "=========================================="
echo "Environment Configuration Check"
echo "=========================================="
echo ""

ENV_FILE=".env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ No .env.local file found!"
  echo ""
  echo "Create one from the template:"
  echo "  cp .env.example .env.local"
  echo "  # Then edit .env.local with your values"
  echo ""
  exit 1
fi

echo "✓ Found $ENV_FILE"
echo ""

# Function to check if a variable is set in .env.local
check_var() {
  local var_name=$1
  local display_name=$2
  local required=$3
  
  # Source the file and check the variable
  if grep -q "^${var_name}=" "$ENV_FILE"; then
    local value=$(grep "^${var_name}=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
    if [[ -n "$value" && "$value" != "your_"* && "$value" != "password" ]]; then
      echo "  ✓ ${display_name}: Set"
      return 0
    else
      echo "  ⚠️  ${display_name}: Empty or placeholder"
      return 1
    fi
  else
    if [[ "$required" == "required" ]]; then
      echo "  ❌ ${display_name}: Not set (REQUIRED)"
      return 1
    else
      echo "  ⚠️  ${display_name}: Not set (optional)"
      return 2
    fi
  fi
}

echo "Monitoring Database (Required):"
MONITORING_OK=true
check_var "MONITORING_DB_HOST" "Host" "required" || MONITORING_OK=false
check_var "MONITORING_DB_PORT" "Port" "required" || MONITORING_OK=false
check_var "MONITORING_DB_NAME" "Database" "required" || MONITORING_OK=false
check_var "MONITORING_DB_USER" "User" "required" || MONITORING_OK=false
check_var "MONITORING_DB_PASSWORD" "Password" "required" || MONITORING_OK=false

echo ""
echo "Source/Target Databases (Optional - for viewing tables without subscriptions):"
DB_CONNECTIONS_OK=true
check_var "SOURCE_DATABASE_URL" "Source DB URL" "optional" || DB_CONNECTIONS_OK=false
check_var "TARGET_DATABASE_URL" "Target DB URL" "optional" || DB_CONNECTIONS_OK=false

echo ""
echo "=========================================="
echo "Summary"
echo "=========================================="
echo ""

if [[ "$MONITORING_OK" == "true" ]]; then
  echo "✓ Monitoring database is configured"
  echo "  The dashboard should be able to connect"
else
  echo "❌ Monitoring database is NOT properly configured"
  echo "  The dashboard will NOT work"
  echo ""
  echo "Fix by editing .env.local and setting:"
  echo "  MONITORING_DB_HOST=..."
  echo "  MONITORING_DB_PORT=5432"
  echo "  MONITORING_DB_NAME=replication_monitoring"
  echo "  MONITORING_DB_USER=postgres"
  echo "  MONITORING_DB_PASSWORD=..."
fi

echo ""

if [[ "$DB_CONNECTIONS_OK" == "true" ]]; then
  echo "✓ Source/Target database URLs are configured"
  echo "  You can view tables WITHOUT creating subscriptions"
  echo "  (Row count diffs will be empty until you create a subscription)"
else
  echo "⚠️  Source/Target database URLs are NOT configured"
  echo "  You will need to create a subscription to view tables"
  echo ""
  echo "To view tables without subscriptions, add to .env.local:"
  echo "  SOURCE_DATABASE_URL=postgresql://user:pass@host:5432/dbname"
  echo "  TARGET_DATABASE_URL=postgresql://user:pass@host:5432/dbname"
  echo ""
  echo "Or run: ./setup-env-from-secret.sh (if using K8s secrets)"
fi

echo ""

if [[ "$MONITORING_OK" == "true" ]]; then
  echo "Next steps:"
  echo "  1. Start the dashboard: npm run dev"
  echo "  2. Open http://localhost:3002"
  if [[ "$DB_CONNECTIONS_OK" == "true" ]]; then
    echo "  3. Tables should be visible immediately"
  else
    echo "  3. Create a subscription at /subscriptions/new to see tables"
  fi
  exit 0
else
  echo "Cannot proceed until monitoring database is configured."
  exit 1
fi

