#!/bin/bash
set -euo pipefail

# List all tables with their assigned groups and sizes
# Helps verify table grouping before creating subscriptions

echo "=============================================="
echo "Table Groups Analysis"
echo "=============================================="
echo ""

# Load environment
if [[ ! -f .env.local ]]; then
  echo "❌ Error: .env.local not found"
  exit 1
fi

SOURCE_DATABASE_URL=$(grep "^SOURCE_DATABASE_URL=" .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'" | sed 's/\\\$/$/g' | sed 's/\\=/=/g')

if [[ -z "${SOURCE_DATABASE_URL:-}" ]]; then
  echo "❌ Error: SOURCE_DATABASE_URL not found"
  exit 1
fi

# Parse connection details
SOURCE_DB_HOST=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*@\([^:\/]*\).*/\1/p')
SOURCE_DB_PORT=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*:\([0-9]*\)\/.*/\1/p' || echo "5432")
SOURCE_DB_NAME=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p')
SOURCE_DB_USER=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*\/\/\([^:]*\):.*/\1/p')
SOURCE_DB_PASSWORD=$(echo "$SOURCE_DATABASE_URL" | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p' | sed 's/\\//g')

echo "Source Database: ${SOURCE_DB_HOST}/${SOURCE_DB_NAME}"
echo ""
echo "Fetching table list..."
echo ""

# Get all tables with sizes
PGPASSWORD="$SOURCE_DB_PASSWORD" psql -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" <<'SQL'
\pset border 2
\pset format wrapped

-- Table grouping analysis
WITH table_info AS (
  SELECT 
    c.relname as table_name,
    pg_size_pretty(pg_total_relation_size(c.oid)) as size,
    pg_total_relation_size(c.oid) as size_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' 
  AND c.relkind = 'r'
),
-- Define excluded tables
excluded AS (
  SELECT unnest(ARRAY[
    'AccountCollateralBalanceSeries',
    'OwnerAddressTotalBalanceSeries',
    'AccountBalanceSeries',
    'stork_asset_price_history',
    'AccountTotalBalanceSeries',
    'FundingRateSeries',
    'pool_price_history'
  ]) as table_name,
  '🔴 EXCLUDED - Huge Time Series' as category
  UNION ALL
  SELECT unnest(ARRAY[
    'orders',
    'order_history',
    'PositionSeries'
  ]) as table_name,
  '🟠 EXCLUDED - Fast-Indexer' as category
  UNION ALL
  SELECT unnest(ARRAY[
    'margin_accounts_balance_entries',
    'account_collateral_balance_entries',
    'lp_account_balance_entries',
    'lp_unified_account_balance_entries',
    'auto_rebalance_transactions',
    'account_owner_configuration',
    'account_owner_updated_history',
    'account_owner_updated_snapshot',
    'account_signature_nonce',
    'account_signature_nonce_pool',
    'account_tier',
    'auto_exchange',
    'auto_exchange_configrations',
    'auto_rebalance_allocation_configuration',
    'auto_rebalance_target_ratio_post_quote',
    'collateral_configuration',
    'fee_tier_parameters',
    'global_fee_parameters',
    'liquidation_configuration',
    'market_configuration',
    'market_storage',
    'pool_created',
    'rebate_fee_history',
    'referral_mapping_event',
    'referral_mappings',
    'referrer_account_tier_event',
    'referrer_tier_rebate_event',
    'risk_matrix',
    'risk_multipliers_configuration',
    'socket_withdraw_fees',
    'tier_fee'
  ]) as table_name,
  '🟡 EXCLUDED - Goldsky' as category
),
-- Define included groups
core_large AS (
  SELECT unnest(ARRAY[
    'ConditionalOrders',
    'BridgeTransactionsPool',
    'BridgeTransactionsMarginAccount',
    'trades'
  ]) as table_name,
  '✅ Group 1 - Core Large' as category
),
app_medium AS (
  SELECT unnest(ARRAY[
    'AccountProfile',
    'AccountLeveragePerMarket',
    'LpPoolBalanceSeries',
    'LpPoolBalanceSeriesV2',
    'PriceSeries'
  ]) as table_name,
  '✅ Group 2 - App Medium' as category
),
app_small AS (
  SELECT unnest(ARRAY[
    'AccountTierFeeMonitoring',
    'AffiliateWallets',
    'AlphaSignatures',
    'Asset',
    'Candle',
    'LpPoolAddressPerformanceSeries',
    'PriceFeedMonitoring',
    'RandomBoost',
    'ToSExtendedVersions',
    'ToSSignatures',
    'ToSVersions',
    'TradingBoost',
    'TradingLotteryBoost',
    'WalletDetails'
  ]) as table_name,
  '✅ Group 3 - App Small' as category
),
categorized AS (
  SELECT t.*, COALESCE(e.category, c.category, m.category, s.category, '✅ Group 4 - App Remaining') as category
  FROM table_info t
  LEFT JOIN excluded e ON e.table_name = t.table_name
  LEFT JOIN core_large c ON c.table_name = t.table_name
  LEFT JOIN app_medium m ON m.table_name = t.table_name
  LEFT JOIN app_small s ON s.table_name = t.table_name
)
SELECT 
  table_name as "Table",
  size as "Size",
  category as "Group"
FROM categorized
ORDER BY 
  CASE 
    WHEN category LIKE '%EXCLUDED%' THEN 0
    WHEN category LIKE '%Group 1%' THEN 1
    WHEN category LIKE '%Group 2%' THEN 2
    WHEN category LIKE '%Group 3%' THEN 3
    ELSE 4
  END,
  size_bytes DESC;

-- Summary statistics
\echo ''
\echo '==============================================='
\echo 'Summary Statistics'
\echo '==============================================='

WITH table_info AS (
  SELECT 
    c.relname as table_name,
    pg_total_relation_size(c.oid) as size_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' 
  AND c.relkind = 'r'
),
excluded AS (
  SELECT unnest(ARRAY[
    'AccountCollateralBalanceSeries',
    'OwnerAddressTotalBalanceSeries',
    'AccountBalanceSeries',
    'stork_asset_price_history',
    'AccountTotalBalanceSeries',
    'FundingRateSeries',
    'pool_price_history',
    'orders',
    'order_history',
    'PositionSeries',
    'margin_accounts_balance_entries',
    'account_collateral_balance_entries',
    'lp_account_balance_entries',
    'lp_unified_account_balance_entries',
    'auto_rebalance_transactions',
    'account_owner_configuration',
    'account_owner_updated_history',
    'account_owner_updated_snapshot',
    'account_signature_nonce',
    'account_signature_nonce_pool',
    'account_tier',
    'auto_exchange',
    'auto_exchange_configrations',
    'auto_rebalance_allocation_configuration',
    'auto_rebalance_target_ratio_post_quote',
    'collateral_configuration',
    'fee_tier_parameters',
    'global_fee_parameters',
    'liquidation_configuration',
    'market_configuration',
    'market_storage',
    'pool_created',
    'rebate_fee_history',
    'referral_mapping_event',
    'referral_mappings',
    'referrer_account_tier_event',
    'referrer_tier_rebate_event',
    'risk_matrix',
    'risk_multipliers_configuration',
    'socket_withdraw_fees',
    'tier_fee'
  ]) as table_name
)
SELECT 
  COUNT(*) as "Total Tables",
  pg_size_pretty(SUM(size_bytes)) as "Total Size",
  COUNT(*) FILTER (WHERE table_name NOT IN (SELECT table_name FROM excluded)) as "Tables to Replicate",
  pg_size_pretty(SUM(size_bytes) FILTER (WHERE table_name NOT IN (SELECT table_name FROM excluded))) as "Size to Replicate",
  COUNT(*) FILTER (WHERE table_name IN (SELECT table_name FROM excluded)) as "Tables Excluded",
  pg_size_pretty(SUM(size_bytes) FILTER (WHERE table_name IN (SELECT table_name FROM excluded))) as "Size Excluded"
FROM table_info;

SQL

echo ""
echo "=============================================="
echo "Next Steps"
echo "=============================================="
echo ""
echo "1. Review the table groups above"
echo "2. Run: ./scripts/setup-grouped-subscriptions.sh"
echo "3. Monitor: http://localhost:3002/subscriptions"
echo ""
