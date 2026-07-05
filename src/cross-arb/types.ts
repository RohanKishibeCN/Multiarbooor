export type Platform = 'POLYMARKET' | 'PREDICTFUN';

export interface UnifiedMarket {
  platform: Platform;
  id: string;
  slug: string;
  title: string;
  question: string;
  outcomes: string[];
  tokenIds: { yes: string; no: string };
  isNegRisk: boolean;
  isYieldBearing: boolean;
  feeRateBps: number;
  tickSize: number;
  status: string;
  volume24h: number;
  liquidity: number;
  endDate: number;
  resolutionSource: string;
}

export interface UnifiedOrderbook {
  platform: Platform;
  marketId: string;
  timestamp: number;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  tickSize: number;
}

export interface MatchedEvent {
  id: string;
  pmMarket: UnifiedMarket;
  pfMarket: UnifiedMarket;
  confidence: number;
  titleSimilarity: number;
  resolutionMatch: boolean;
}

export interface CrossMarketSnapshot {
  timestamp: number;
  event: MatchedEvent;
  pmOrderbook: UnifiedOrderbook;
  pfOrderbook: UnifiedOrderbook;
  costPM_YES_PF_NO: number;
  costPM_NO_PF_YES: number;
  profitBps_PM_YES_PF_NO: number;
  profitBps_PM_NO_PF_YES: number;
  bestDirection: 'PM_YES_PF_NO' | 'PM_NO_PF_YES';
  bestProfitBps: number;
  bestQuantity: number;
}

export interface CrossMarketOpportunity extends CrossMarketSnapshot {
  estimatedFees: {
    polymarketTakerFee: number;
    predictfunFee: number;
    bridgeFee: number;
    totalGasUSDT: number;
  };
  estimatedNetProfitUSDT: number;
  requiredCollateral: {
    polymarketUSDC: number;
    predictfunUSDT: number;
  };
  score: number;
}

export interface CrossMarketExecutionResult {
  success: boolean;
  opportunity: CrossMarketOpportunity;
  pmOrderId: string;
  pfOrderHash: string;
  pmStatus: string;
  pfStatus: string;
  hedged: boolean;
  netProfitUSDT: number;
  executionTimeMs: number;
  error?: string;
}

export interface CrossTradeRecord {
  timestamp: number;
  eventTitle: string;
  pmMarketTitle: string;
  pfMarketTitle: string;
  direction: 'PM_YES_PF_NO' | 'PM_NO_PF_YES';
  quantity: number;
  pmPrice: number;
  pfPrice: number;
  estimatedProfit: number;
  netProfit: number;
  success: boolean;
  hedged: boolean;
  error?: string;
}
