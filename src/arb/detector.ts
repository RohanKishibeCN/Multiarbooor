import { OrderbookData, OrderbookLevel, ArbitrageOpportunity, MarketInfo } from './types';
import { AppConfig } from '../config';

export class ArbitrageDetector {

  static getComplement(price: number, decimalPrecision: number = 2): number {
    const factor = Math.pow(10, decimalPrecision);
    return (factor - Math.round(price * factor)) / factor;
  }

  static deriveNoSideBook(
    yesAsks: OrderbookLevel[],
    yesBids: OrderbookLevel[],
    decimalPrecision: number = 2
  ): { noBids: OrderbookLevel[]; noAsks: OrderbookLevel[] } {
    const noBids = yesAsks.map(([p, q]) => [
      this.getComplement(p, decimalPrecision),
      q,
    ] as OrderbookLevel);
    const noAsks = yesBids.map(([p, q]) => [
      this.getComplement(p, decimalPrecision),
      q,
    ] as OrderbookLevel);
    return { noBids, noAsks };
  }

  detectComplementArbitrage(
    book: OrderbookData,
    marketInfo: MarketInfo,
    decimalPrecision: number = AppConfig.decimalPrecisionDefault
  ): ArbitrageOpportunity | null {
    if (book.asks.length === 0 || book.bids.length === 0) return null;

    const yesBestBid = book.bids[0][0];
    const yesBestAsk = book.asks[0][0];
    const noBestBid = ArbitrageDetector.getComplement(book.asks[0][0], decimalPrecision);
    const noBestAsk = ArbitrageDetector.getComplement(book.bids[0][0], decimalPrecision);

    const sumBid = parseFloat((yesBestBid + noBestBid).toFixed(decimalPrecision));
    const sumAsk = parseFloat((yesBestAsk + noBestAsk).toFixed(decimalPrecision));

    const estimatedGasUSDT = AppConfig.estimatedGasBnb * AppConfig.bnbPriceUSDT * 2;

    const sellProfitBps = Math.round((sumBid - 1) * 10000);
    if (sellProfitBps >= AppConfig.minProfitBps) {
      const quantity = Math.min(
        book.bids[0][1],
        book.asks[0][1]
      );
      const sellQuantity = Math.min(quantity, AppConfig.maxPositionPerMarket);
      const estimatedProfit = (sumBid - 1) * sellQuantity;
      const netProfit = estimatedProfit - estimatedGasUSDT;

      if (netProfit <= 0) return null;

      return {
        marketId: book.marketId,
        type: 'SELL_BOTH',
        timestamp: Date.now(),
        yesBid: yesBestBid,
        yesAsk: yesBestAsk,
        noBid: noBestBid,
        noAsk: noBestAsk,
        sumBid,
        sumAsk,
        profitBps: sellProfitBps,
        quantity: sellQuantity,
        estimatedProfitUSDT: parseFloat(estimatedProfit.toFixed(4)),
        estimatedFeesUSDT: 0,
        estimatedGasUSDT,
        netProfitUSDT: parseFloat(netProfit.toFixed(4)),
      };
    }

    const buyProfitBps = Math.round((1 - sumAsk) * 10000);
    if (buyProfitBps >= AppConfig.minProfitBps) {
      const quantity = Math.min(
        book.asks[0][1],
        book.bids[0][1]
      );
      const buyQuantity = Math.min(quantity, AppConfig.maxPositionPerMarket);
      const estimatedProfit = (1 - sumAsk) * buyQuantity;
      const netProfit = estimatedProfit - estimatedGasUSDT;

      if (netProfit <= 0) return null;

      return {
        marketId: book.marketId,
        type: 'BUY_BOTH',
        timestamp: Date.now(),
        yesBid: yesBestBid,
        yesAsk: yesBestAsk,
        noBid: noBestBid,
        noAsk: noBestAsk,
        sumBid,
        sumAsk,
        profitBps: buyProfitBps,
        quantity: buyQuantity,
        estimatedProfitUSDT: parseFloat(estimatedProfit.toFixed(4)),
        estimatedFeesUSDT: 0,
        estimatedGasUSDT,
        netProfitUSDT: parseFloat(netProfit.toFixed(4)),
      };
    }

    return null;
  }

  scanMarket(
    book: OrderbookData,
    marketInfo: MarketInfo
  ): ArbitrageOpportunity | null {
    return this.detectComplementArbitrage(book, marketInfo, marketInfo.decimalPrecision || AppConfig.decimalPrecisionDefault);
  }
}
