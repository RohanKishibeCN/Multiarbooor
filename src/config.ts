import dotenv from 'dotenv';
dotenv.config();

function envInt(key: string, defaultVal: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : defaultVal;
}

function envFloat(key: string, defaultVal: number): number {
  const val = process.env[key];
  return val ? parseFloat(val) : defaultVal;
}

function envBool(key: string, defaultVal: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === null || val === '') return defaultVal;
  return val === 'true' || val === '1' || val === 'yes';
}

export const AppConfig = {
  apiBaseUrl: process.env.PREDICT_API_URL || 'https://api.predict.fun',
  apiKey: process.env.PREDICT_API_KEY || '',

  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',

  privyWalletPrivateKey: process.env.PRIVY_WALLET_PRIVATE_KEY || '',

  predictAccountAddress: process.env.PREDICT_ACCOUNT_ADDRESS || '',

  minProfitBps: envInt('MIN_PROFIT_BPS', 150),
  maxPositionPerMarket: envInt('MAX_POSITION_PER_MARKET', 10000),
  maxTotalExposure: envInt('MAX_TOTAL_EXPOSURE', 50000),
  orderTimeoutMs: envInt('ORDER_TIMEOUT_MS', 15000),
  maxSlippageBps: envInt('MAX_SLIPPAGE_BPS', 30),
  estimatedGasBnb: envFloat('ESTIMATED_GAS_BNB', 0.0008),
  bnbPriceUSDT: envFloat('BNB_PRICE_USDT', 600),

  notionToken: process.env.NOTION_TOKEN || '',
  notionDatabaseId: process.env.NOTION_DATABASE_ID || '',

  dailyReportCron: process.env.DAILY_REPORT_CRON || '59 23 * * *',
  arbScanCron: process.env.ARB_SCAN_CRON || '*/5 * * * *',

  enableInternalArb: envBool('ENABLE_INTERNAL_ARB', true),
  enableCrossArb: envBool('ENABLE_CROSS_ARB', true),

  decimalPrecisionDefault: 2,

  polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
  polymarketFunderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || '',
  crossMinProfitBps: envInt('CROSS_MIN_PROFIT_BPS', 100),
  crossMaxPositionValue: envInt('CROSS_MAX_POSITION_VALUE', 5000),
  crossBridgeFeeBps: envInt('CROSS_BRIDGE_FEE_BPS', 20),
  crossSlippageBps: envInt('CROSS_SLIPPAGE_BPS', 30),
  crossExecutionTimeoutMs: envInt('CROSS_EXECUTION_TIMEOUT_MS', 15000),
  crossTargetRatio: envFloat('CROSS_TARGET_RATIO', 0.5),
  crossRebalanceThreshold: envFloat('CROSS_REBALANCE_THRESHOLD', 0.15),
  crossEventMatchThreshold: envFloat('CROSS_EVENT_MATCH_THRESHOLD', 0.5),
};

export function isUsingPredictAccount(): boolean {
  return !!AppConfig.predictAccountAddress;
}

export function getSignerPrivateKey(): string {
  return isUsingPredictAccount() && AppConfig.privyWalletPrivateKey
    ? AppConfig.privyWalletPrivateKey
    : AppConfig.walletPrivateKey;
}
