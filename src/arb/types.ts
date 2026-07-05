export type OrderbookLevel = [number, number];

export interface OrderbookData {
  marketId: number;
  updateTimestampMs: number;
  asks: OrderbookLevel[];
  bids: OrderbookLevel[];
}

export interface ArbitrageOpportunity {
  marketId: number;
  type: 'SELL_BOTH' | 'BUY_BOTH';
  timestamp: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  sumBid: number;
  sumAsk: number;
  profitBps: number;
  quantity: number;
  estimatedProfitUSDT: number;
  estimatedFeesUSDT: number;
  estimatedGasUSDT: number;
  netProfitUSDT: number;
}

export interface MarketInfo {
  id: number;
  title: string;
  question: string;
  decimalPrecision: number;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  feeRateBps: number;
  outcomes: {
    name: string;
    onChainId: string;
    indexSet: number;
  }[];
}

export interface OrderResult {
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  orderHash: string;
  orderId: string;
  status: 'FILLED' | 'PARTIAL' | 'PENDING' | 'FAILED';
  filledQuantity: number;
  filledPrice: number;
}

export interface ExecutionResult {
  success: boolean;
  opportunity: ArbitrageOpportunity;
  orders: OrderResult[];
  netProfitUSDT: number;
  executionTimeMs: number;
  error?: string;
}

export interface TradeRecord {
  timestamp: number;
  marketId: number;
  marketTitle: string;
  type: 'SELL_BOTH' | 'BUY_BOTH';
  yesPrice: number;
  noPrice: number;
  quantity: number;
  estimatedProfit: number;
  netProfit: number;
  success: boolean;
  orderHashes: string[];
  error?: string;
}

export interface DailyReport {
  date: string;
  totalTrades: number;
  successfulTrades: number;
  totalEstimatedProfit: number;
  totalNetProfit: number;
  failedTrades: number;
  trades: TradeRecord[];
  summary: string;
  scanInfo?: string;
}
