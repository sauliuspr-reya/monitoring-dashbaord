/**
 * Organize Reya DEX tables into logical subscription groups
 * Based on business domain and usage patterns
 */

export interface TableGroup {
  name: string;
  description: string;
  tables: string[];
  priority: 'high' | 'medium' | 'low';
}

export const TABLE_GROUPS: TableGroup[] = [
  {
    name: 'accounts',
    description: 'Account profiles, leverage, tiers, balances, and account-level configurations',
    priority: 'high',
    tables: [
      'AccountProfile',
      'AccountLeveragePerMarket',
      'AccountTierFeeMonitoring',
      'EmbeddedWallets',
      'Passkeys',
      'AffiliateWallets',
      'account_balances',
      'account_collateral_net_balance',
      'WalletDetails',
      'WalletDiscordLink',
      'WalletEvents',
      'WalletMarketPreference',
    ],
  },
  {
    name: 'markets',
    description: 'Market definitions, spot markets, and market configurations',
    priority: 'high',
    tables: [
      'Market',
      'SpotMarket',
      'spot_market_definitions',
    ],
  },
  {
    name: 'assets',
    description: 'Asset definitions and price data',
    priority: 'high',
    tables: [
      'Asset',
      'PriceFeedMonitoring',
    ],
  },
  {
    name: 'trading',
    description: 'Trading orders, candles, conditional orders, swaps, and trading stats',
    priority: 'high',
    tables: [
      'ConditionalOrders',
      'Candle',
      'SpotCandle',
      'swaps',
      'trading_stats_account',
      'trading_stats_account_market',
      'trading_stats_wallet',
      'order_with_vol_price_impact',
      'order_off_chain_trackers',
      'orders_copy',
      'orders_duplicates',
      'orders_migration',
    ],
  },
  {
    name: 'bridges',
    description: 'Bridge transactions for margin accounts and pools',
    priority: 'high',
    tables: [
      'BridgeTransactionsMarginAccount',
      'BridgeTransactionsPool',
    ],
  },
  {
    name: 'funding',
    description: 'Funding rates and funding-related data',
    priority: 'medium',
    tables: [
      'FundingRateSeries',
    ],
  },
  {
    name: 'liquidity',
    description: 'Liquidity pools, LP performance, and pool details',
    priority: 'medium',
    tables: [
      'PoolDetails',
      'LpPoolAddressPerformanceSeries',
      'LpPoolBalanceSeries',
      'LpPoolBalanceSeriesV2',
      'LiquidityTrancheBoostV4',
      'LiquidityXpV4',
      'LiquidityXpV4Backup',
      'LiquidityXpV5',
    ],
  },
  {
    name: 'points',
    description: 'Points system, multipliers, and baseline configurations',
    priority: 'medium',
    tables: [
      'PointsBaseline',
      'PointsMultipliers',
      'PointsSignalPoints',
      'PointsXpOpenInterestSnapshots',
      'PointsXpStakingSnapshots',
    ],
  },
  {
    name: 'leaderboards',
    description: 'XP leaderboards, rankings, and competition snapshots',
    priority: 'medium',
    tables: [
      'LatestXpLeaderboardSnapshots',
      'LatestXpLeaderboardSnapshotsBackup',
      'LatestXpLeaderboardSnapshotsV5',
      'LatestXpLeaderboardV3',
      'LeaderBoardsTempSep192025',
      'RageTradeCompetitionSnapshot',
    ],
  },
  {
    name: 'rankings',
    description: 'Rank claims and ranking-related data',
    priority: 'medium',
    tables: [
      'RankClaim',
      'RankClaimTrading',
      'OriginalRankClaim',
    ],
  },
  {
    name: 'referrals',
    description: 'Referral system and referral codes',
    priority: 'medium',
    tables: [
      'Referral',
      'ReferralCode',
    ],
  },
  {
    name: 'rewards',
    description: 'Lottery, boosts, and reward systems',
    priority: 'low',
    tables: [
      'LotteryWinners',
      'RandomBoost',
      'TradingBoost',
      'TradingLotteryBoost',
    ],
  },
  {
    name: 'pricing',
    description: 'Price series, asset prices, and price history',
    priority: 'medium',
    tables: [
      'PriceSeries',
      'asset_price',
      'asset_price_history',
      'asset_price_interval',
      'pool_price_history',
      'pool_price_snapshot',
      'StorkPriceCandle',
      'StorkPriceUpdates',
    ],
  },
  {
    name: 'seasons',
    description: 'End of season data and seasonal configurations',
    priority: 'low',
    tables: [
      'EndOfSeasonData',
    ],
  },
  {
    name: 'signatures',
    description: 'Alpha signatures and signature-related data',
    priority: 'low',
    tables: [
      'AlphaSignatures',
    ],
  },
  {
    name: 'positions',
    description: 'Position data and position-related tracking',
    priority: 'high',
    tables: [
      'positions',
      'positions_migration',
      'temp_position_avg_funding',
    ],
  },
  {
    name: 'market_tracking',
    description: 'Market tracking, volatility, and market analytics',
    priority: 'medium',
    tables: [
      'market_trackers_history',
      'market_trackers_interval',
      'market_volatility_configuration',
      'market_volatility_configuration_history',
    ],
  },
  {
    name: 'liquidation',
    description: 'Liquidation history and details',
    priority: 'medium',
    tables: [
      'liquidation_history_details',
    ],
  },
  {
    name: 'xp_system',
    description: 'XP system, user XP, and XP-related snapshots',
    priority: 'medium',
    tables: [
      'XpUserV3',
      'XpV3LeaderboardSnapshot',
      'TradingXpV4',
      'TradingXpV5',
      'TradingInstantBoostV4',
      'TradingLotteryXpSnapshot',
      'TraderActivitySnapshots',
      'XpNftAwards',
    ],
  },
  {
    name: 'tos',
    description: 'Terms of Service versions and signatures',
    priority: 'low',
    tables: [
      'ToSVersions',
      'ToSExtendedVersions',
      'ToSSignatures',
    ],
  },
  {
    name: 'governance',
    description: 'Voting and governance-related tables',
    priority: 'low',
    tables: [
      'votes',
      'vote_metadata',
    ],
  },
  {
    name: 'risk',
    description: 'Risk management and risk results',
    priority: 'medium',
    tables: [
      'TrmRiskResult',
      'rebalancing_discount',
    ],
  },
  {
    name: 'transactions',
    description: 'Transaction flow and status tracking',
    priority: 'medium',
    tables: [
      'TransactionFlowStatus',
    ],
  },
  {
    name: 'rate_limits',
    description: 'Rate limiting and whitelist configurations',
    priority: 'low',
    tables: [
      'rate_limit_trades_whitelist',
    ],
  },
  {
    name: 'sbt',
    description: 'Soulbound token mints',
    priority: 'low',
    tables: [
      'sbt_mints',
    ],
  },
  {
    name: 'monitoring',
    description: 'Monitoring, helpers, and operational tables',
    priority: 'low',
    tables: [
      'CronHelper',
      'DiscordRankUpdaterHelper',
      'SocketDepositFees',
      '_prisma_migrations',
    ],
  },
];

