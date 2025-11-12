#!/bin/bash
set -euo pipefail

# Setup PostgreSQL logical replication with table groups
# This creates separate publications/subscriptions for different table categories
# EXCLUDES: Huge time series tables (1.61 TB) - these will be handled separately

echo "=============================================="
echo "Setup Grouped Subscriptions for Reya Migration"
echo "=============================================="
echo ""

# Load environment from .env.local
if [[ ! -f .env.local ]]; then
  echo "❌ Error: .env.local not found"
  exit 1
fi

SOURCE_DATABASE_URL=$(grep "^SOURCE_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')
TARGET_DATABASE_URL=$(grep "^DESTINATION_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')

if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  TARGET_DATABASE_URL=$(grep "^TARGET_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g' || echo "")
fi

if [[ -z "${SOURCE_DATABASE_URL:-}" ]] || [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  echo "❌ Error: Missing required environment variables in .env.local"
  exit 1
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

# Define table groups
# Format: GROUP_NAME|DESCRIPTION|TABLE_LIST

declare -a TABLE_GROUPS=(
  # Group 1: Core Application Tables (Priority 1 - Large tables)
  "app_core_large|Core application tables (large)|ConditionalOrders,BridgeTransactionsPool,BridgeTransactionsMarginAccount"
  
  # Group 2: Application Medium Tables (Priority 2)
  "app_medium|Application tables (medium)|AccountProfile,AccountLeveragePerMarket,LpPoolBalanceSeries,LpPoolBalanceSeriesV2,PriceSeries"
  
  # Group 3: Application Small Tables (Priority 3)
  "app_small|Application tables (small)|AccountTierFeeMonitoring,AffiliateWallets,AlphaSignatures,Asset,Candle,LpPoolAddressPerformanceSeries,PriceFeedMonitoring,RandomBoost,ToSExtendedVersions,ToSSignatures,ToSVersions,TradingBoost,TradingLotteryBoost,WalletDetails"
  
  # Group 4: Application Remaining Tables (Priority 4)
  "app_remaining|Application tables (remaining)|*"
  
  # Group 5: Goldsky Tables (Reference only - not replicated)
  # "goldsky|Goldsky-managed tables|margin_accounts_balance_entries,account_collateral_balance_entries,lp_account_balance_entries,lp_unified_account_balance_entries,auto_rebalance_transactions,account_owner_configuration,account_owner_updated_history,account_owner_updated_snapshot,account_signature_nonce,account_signature_nonce_pool,account_tier,auto_exchange,auto_exchange_configrations,auto_rebalance_allocation_configuration,auto_rebalance_target_ratio_post_quote,collateral_configuration,fee_tier_parameters,global_fee_parameters,liquidation_configuration,market_configuration,market_storage,pool_created,rebate_fee_history,referral_mapping_event,referral_mappings,referrer_account_tier_event,referrer_tier_rebate_event,risk_matrix,risk_multipliers_configuration,socket_withdraw_fees,tier_fee"
  
  # Group 6: Fast-Indexer Tables (Reference only - not replicated)
  # "fast_indexer|Fast-indexer tables|orders,order_history,PositionSeries"
)

# Tables to ALWAYS exclude (huge time series - 1.61 TB)
EXCLUDED_TABLES=(
  "AccountCollateralBalanceSeries"
  "OwnerAddressTotalBalanceSeries"
  "AccountBalanceSeries"
  "stork_asset_price_history"
  "AccountTotalBalanceSeries"
  "FundingRateSeries"
  "pool_price_history"
)

echo "⚠️  The following HUGE time series tables will be EXCLUDED:"
printf '   - %s\n' "${EXCLUDED_TABLES[@]}"
echo ""
echo "   Total excluded: ~1.61 TB"
echo ""

read -p "Continue with grouped subscription setup? [y/N]: " confirm
echo ""

if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted"
  exit 0
fi

# Track tables already assigned to groups
ASSIGNED_TABLES=()

# Function to create publication on source
create_publication() {
  local pub_name=$1
  local table_list=$2
  
  echo "Creating publication: ${pub_name}"
  
  # Build table list for publication
  local tables=""
  if [[ "$table_list" == "*" ]]; then
    # Get all tables except excluded ones AND already assigned tables
    local all_excluded=("${EXCLUDED_TABLES[@]}" "${ASSIGNED_TABLES[@]}")
    local exclude_pattern=$(printf "'%s'," "${all_excluded[@]}")
    exclude_pattern="${exclude_pattern%,}"  # Remove trailing comma
    
    tables=$(PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -t -A -c "
      SELECT string_agg('public.' || quote_ident(tablename), ', ')
      FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename NOT IN ($exclude_pattern)
    ")
  else
    # Use specific table list
    IFS=',' read -ra TABLE_ARRAY <<< "$table_list"
    for table in "${TABLE_ARRAY[@]}"; do
      if [[ -n "$tables" ]]; then
        tables="$tables, "
      fi
      tables="${tables}public.\"${table}\""
      # Track this table as assigned
      ASSIGNED_TABLES+=("$table")
    done
  fi
  
  if [[ -z "$tables" ]]; then
    echo "   ⚠️  No tables to publish, skipping"
    return 1
  fi
  
  # Drop existing publication if exists
  PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -c "
    DROP PUBLICATION IF EXISTS ${pub_name};
  " > /dev/null 2>&1 || true
  
  # Create publication
  PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -c "
    CREATE PUBLICATION ${pub_name} FOR TABLE ${tables};
  "
  
  echo "   ✅ Publication created"
  return 0
}

# Function to create subscription on target
create_subscription() {
  local sub_name=$1
  local pub_name=$2
  local slot_name=$3
  
  echo "Creating subscription: ${sub_name}"
  
  # Drop existing subscription if exists
  PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -c "
    DROP SUBSCRIPTION IF EXISTS ${sub_name};
  " > /dev/null 2>&1 || true
  
  # Create subscription with copy_data=false (schema already exists)
  PGPASSWORD="$TARGET_DB_PASSWORD" psql -h "$TARGET_DB_HOST" -p "$TARGET_DB_PORT" -U "$TARGET_DB_USER" -d "$TARGET_DB_NAME" -c "
    CREATE SUBSCRIPTION ${sub_name}
    CONNECTION '${SOURCE_DATABASE_URL}'
    PUBLICATION ${pub_name}
    WITH (
      copy_data = true,
      create_slot = true,
      slot_name = ${slot_name},
      streaming = true
    );
  "
  
  echo "   ✅ Subscription created"
}

# Process each table group
echo "=========================================="
echo "Creating Publications and Subscriptions"
echo "=========================================="
echo ""

CREATED=0
SKIPPED=0
ERRORS=0

for group_def in "${TABLE_GROUPS[@]}"; do
  IFS='|' read -r group_name description table_list <<< "$group_def"
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Group: ${group_name}"
  echo "Description: ${description}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  pub_name="pub_${group_name}"
  sub_name="sub_${group_name}"
  slot_name="slot_${group_name}"
  
  # Create publication
  if create_publication "$pub_name" "$table_list"; then
    # Create subscription
    if create_subscription "$sub_name" "$pub_name" "$slot_name"; then
      CREATED=$((CREATED + 1))
    else
      echo "   ❌ Failed to create subscription"
      ERRORS=$((ERRORS + 1))
    fi
  else
    SKIPPED=$((SKIPPED + 1))
  fi
  
  echo ""
done

echo "=========================================="
echo "Summary"
echo "=========================================="
echo "Groups processed: ${#TABLE_GROUPS[@]}"
echo "Subscriptions created: ${CREATED}"
echo "Skipped: ${SKIPPED}"
echo "Errors: ${ERRORS}"
echo ""

if [[ $ERRORS -eq 0 ]]; then
  echo "✅ All subscriptions created successfully!"
  echo ""
  echo "Next steps:"
  echo "1. Import subscriptions to dashboard:"
  echo "   ./scripts/import-existing-subscriptions.sh"
  echo ""
  echo "2. Monitor replication lag:"
  echo "   http://localhost:3002/subscriptions"
  echo ""
  echo "3. Check replication status:"
  echo "   ./scripts/check-and-enable-replication.sh"
else
  echo "⚠️  Some subscriptions failed. Check errors above."
fi
echo ""
