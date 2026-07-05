import { MatchedEvent, CrossMarketOpportunity, UnifiedOrderbook } from './types';
import { AppConfig } from '../config';

export class CrossMarketDetector {

  private getComplement(price: number, precision: number = 2): number {
    const factor = Math.pow(10, precision);
    return (factor - Math.round(price * factor)) / factor;
  }

  private calcPMFee(shares: number, price: number, feeRate: number): number {
    return shares * feeRate * price * (1 - price);
  }

  async detectArbitrage(
    match: MatchedEvent,
    pmBook: UnifiedOrderbook,
    pfBook: UnifiedOrderbook
  ): Promise<CrossMarketOpportunity | null> {
    if (pmBook.bids.length === 0 || pmBook.asks.length === 0) return null;
    if (pfBook.bids.length === 0 || pfBook.asks.length === 0) return null;

    const pmYesBestBid = pmBook.bids[0].price;
    const pmYesBestAsk = pmBook.asks[0].price;
    const pfYesBestBid = pfBook.bids[0].price;
    const pfYesBestAsk = pfBook.asks[0].price;

    const pfTicker = parseFloat(match.pfMarket.tickSize.toFixed(2));
    const pfNoAsk = this.getComplement(pfYesBestBid, 2);
    const pmNoAsk = this.getComplement(pmYesBestBid, 2);

    const cost_PM_YES_PF_NO = pmYesBestAsk + pfNoAsk;
    const cost_PM_NO_PF_YES = pmNoAsk + pfYesBestAsk;

    const pmFeeRate = match.pmMarket.feeRateBps / 10000;
    const pmFee1 = this.calcPMFee(1, pmYesBestAsk, pmFeeRate);
    const pmFee2 = this.calcPMFee(1, pmNoAsk, pmFeeRate);

    const pfFeeRate = match.pfMarket.feeRateBps / 10000;
    const pfFee1 = 1 * pfFeeRate * pfNoAsk;
    const pfFee2 = 1 * pfFeeRate * pfYesBestAsk;

    const bridgeFee = (AppConfig.crossBridgeFeeBps / 10000);
    const slippage = (AppConfig.crossSlippageBps / 10000);

    const fees_1 = pmFee1 + pfFee1 + bridgeFee + slippage;
    const profit_1 = 1 - cost_PM_YES_PF_NO - fees_1;
    const profitBps_1 = Math.round(profit_1 * 10000);

    const fees_2 = pmFee2 + pfFee2 + bridgeFee + slippage;
    const profit_2 = 1 - cost_PM_NO_PF_YES - fees_2;
    const profitBps_2 = Math.round(profit_2 * 10000);

    const bestDirection: 'PM_YES_PF_NO' | 'PM_NO_PF_YES' = profit_1 > profit_2 ? 'PM_YES_PF_NO' : 'PM_NO_PF_YES';
    const bestProfitBps = Math.max(profitBps_1, profitBps_2);

    if (bestProfitBps < AppConfig.crossMinProfitBps) return null;

    const bestProfit = bestDirection === 'PM_YES_PF_NO' ? profit_1 : profit_2;
    const pmQuantity = pmBook.asks[0].size;
    const pfQuantity = pfBook.bids[0].size;
    const quantity = Math.min(pmQuantity, pfQuantity, AppConfig.crossMaxPositionValue);

    const snapshot = {
      timestamp: Date.now(),
      event: match,
      pmOrderbook: pmBook,
      pfOrderbook: pfBook,
      costPM_YES_PF_NO: cost_PM_YES_PF_NO,
      costPM_NO_PF_YES: cost_PM_NO_PF_YES,
      profitBps_PM_YES_PF_NO: profitBps_1,
      profitBps_PM_NO_PF_YES: profitBps_2,
      bestDirection,
      bestProfitBps,
      bestQuantity: quantity,
    };

    const estimatedFees = {
      polymarketTakerFee: (bestDirection === 'PM_YES_PF_NO' ? pmFee1 : pmFee2) * quantity,
      predictfunFee: (bestDirection === 'PM_YES_PF_NO' ? pfFee1 : pfFee2) * quantity,
      bridgeFee: bridgeFee * 2 * quantity,
      totalGasUSDT: 2,
    };

    const estimatedNetProfit = bestProfit * quantity - estimatedFees.totalGasUSDT;
    if (estimatedNetProfit <= 0) return null;

    const requiredCollateral = {
      polymarketUSDC: (bestDirection === 'PM_YES_PF_NO' ? pmYesBestAsk : pmNoAsk) * quantity,
      predictfunUSDT: (bestDirection === 'PM_YES_PF_NO' ? pfNoAsk : pfYesBestAsk) * quantity,
    };

    let score = 0;
    score += Math.min(50, (estimatedNetProfit / 100) * 50);
    score += match.confidence * 30;
    const totalLiquidity = match.pmMarket.liquidity + match.pfMarket.liquidity;
    score += Math.min(20, (totalLiquidity / 100000) * 20);

    return {
      ...snapshot,
      estimatedFees,
      estimatedNetProfitUSDT: parseFloat(estimatedNetProfit.toFixed(4)),
      requiredCollateral,
      score,
    };
  }
}
