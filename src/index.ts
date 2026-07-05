import cron from 'node-cron';
import axios from 'axios';
import { OrderBuilder, ChainId } from '@predictdotfun/sdk';
import { Wallet } from 'ethers';
import { JWTManager } from './auth/jwtManager';
import { ArbitrageDetector } from './arb/detector';
import { RiskEngine } from './arb/riskEngine';
import { TradeExecutor } from './executor/tradeExecutor';
import { OrderTracker } from './tracker/orderTracker';
import { NotionReporter } from './reporter/notionReporter';
import { AppConfig, isUsingPredictAccount, getSignerPrivateKey } from './config';
import { MarketInfo, TradeRecord, DailyReport, OrderbookData } from './arb/types';

import { PolymarketConnector } from './cross-arb/connectors/polymarket';
import { EventMatcher } from './cross-arb/matching/eventMatcher';
import { CrossMarketDetector } from './cross-arb/detector';
import { AtomicCoordinator, buildCrossTradeRecord } from './cross-arb/coordinator';
import { CrossTradeRecord, UnifiedMarket } from './cross-arb/types';

class ArbitrageService {
  private jwtManager: JWTManager;
  private detector: ArbitrageDetector;
  private riskEngine: RiskEngine;
  private executor: TradeExecutor;
  private tracker: OrderTracker;
  private reporter: NotionReporter;

  private activeMarkets: Map<number, MarketInfo> = new Map();
  private isProcessing: Set<number> = new Set();

  private todayTrades: TradeRecord[] = [];
  private internalScanCount: number = 0;
  private internalOpportunityCount: number = 0;

  private pm: PolymarketConnector | null = null;
  private crossMatcher: EventMatcher | null = null;
  private crossDetector: CrossMarketDetector | null = null;
  private crossCoordinator: AtomicCoordinator | null = null;

  private crossPfMarkets: UnifiedMarket[] = [];
  private crossPmMarkets: UnifiedMarket[] = [];
  private crossMatchedEvents: any[] = [];
  private crossTodayTrades: CrossTradeRecord[] = [];
  private crossScanCount: number = 0;

  private isRunning: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastReportDate: string = '';

  constructor() {
    this.jwtManager = new JWTManager();
    this.detector = new ArbitrageDetector();
    this.tracker = new OrderTracker(this.jwtManager);
    this.riskEngine = new RiskEngine(this.jwtManager);
    this.executor = new TradeExecutor(this.jwtManager, this.tracker);
    this.reporter = new NotionReporter();

    if (AppConfig.enableCrossArb) {
      this.pm = new PolymarketConnector();
      this.crossMatcher = new EventMatcher();
      this.crossDetector = new CrossMarketDetector();
      this.crossCoordinator = new AtomicCoordinator(this.pm, this.jwtManager, this.tracker);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('========================================');
    console.log('  Predict.fun Arbitrage Bot');
    console.log('========================================');
    console.log(`Wallet address: ${this.jwtManager.getWalletAddress()}`);
    console.log(`API URL: ${AppConfig.apiBaseUrl}`);
    console.log(`  Mode:          ${isUsingPredictAccount() ? 'Predict Account' : 'EOA'}`);
    console.log(`  Internal arb:  ${AppConfig.enableInternalArb ? 'ENABLED' : 'DISABLED'}`);
    console.log(`  Cross-market:  ${AppConfig.enableCrossArb ? 'ENABLED' : 'DISABLED'}`);

    await this.executor.initialize();

    if (AppConfig.enableCrossArb && this.crossCoordinator) {
      const pfOpts = isUsingPredictAccount()
        ? { predictAccount: AppConfig.predictAccountAddress }
        : undefined;
      const pfOrderBuilder = await OrderBuilder.make(
        ChainId.BnbMainnet,
        new Wallet(getSignerPrivateKey()),
        pfOpts
      );
      this.crossCoordinator.setPfOrderBuilder(pfOrderBuilder);
    }

    await this.loadActiveMarkets();
    console.log(`Loaded ${this.activeMarkets.size} Predict.fun active markets`);

    if (AppConfig.enableInternalArb) {
      const arbCron = AppConfig.arbScanCron;
      if (cron.validate(arbCron)) {
        cron.schedule(arbCron, () => this.internalScan());
        console.log(`Internal arb scan: ${arbCron}`);
      } else {
        console.error(`Invalid arb scan cron: ${arbCron}, using */5 * * * *`);
        cron.schedule('*/5 * * * *', () => this.internalScan());
        console.log(`Internal arb scan: */5 * * * * (fallback)`);
      }
    } else {
      console.log('Internal arb scan: DISABLED');
    }

    if (AppConfig.enableCrossArb) {
      cron.schedule('*/10 * * * *', () => this.crossScan());
      console.log(`Cross-market scan: */10 * * * *`);
    } else {
      console.log('Cross-market scan: DISABLED');
    }

    const reportCron = AppConfig.dailyReportCron;
    const rc = cron.validate(reportCron) ? reportCron : '59 23 * * *';
    cron.schedule(rc, () => this.sendDailyReport());
    console.log(`Daily report: ${rc}`);

    this.healthCheckInterval = setInterval(() => this.logHealth(), 60000);

    console.log('Service started successfully');

    if (AppConfig.enableInternalArb) this.internalScan();
    if (AppConfig.enableCrossArb) this.crossScan();
  }

  stop(): void {
    this.isRunning = false;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    console.log('Service stopped');
  }

  private async fetchAllMarkets(): Promise<any[]> {
    const allMarkets: any[] = [];
    let cursor: string | null = null;

    try {
      const token = await this.jwtManager.getToken();

      while (true) {
        const params: any = { first: '500' };
        if (cursor) params.after = cursor;

        const { data } = await axios.get(`${AppConfig.apiBaseUrl}/v1/markets`, {
          headers: { Authorization: `Bearer ${token}`, 'x-api-key': AppConfig.apiKey },
          params,
          timeout: 15000,
        });

        if (!data.success || !data.data || data.data.length === 0) break;

        allMarkets.push(...data.data);
        cursor = data.cursor || null;

        if (!cursor) break;
      }
    } catch (error) {
      console.error('Failed to fetch markets:', error);
    }

    return allMarkets;
  }

  private async loadActiveMarkets(): Promise<void> {
    const allMarkets = await this.fetchAllMarkets();

    console.log(`All markets fetched: ${allMarkets.length}`);
    if (allMarkets.length > 0) {
      const statusCounts: Record<string, number> = {};
      for (const m of allMarkets) {
        statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;
      }
      console.log(`Status distribution: ${JSON.stringify(statusCounts)}`);
    }

    for (const market of allMarkets) {
      if (market.status === 'REGISTERED' || market.status === 'PRICE_PROPOSED' || market.status === 'UNPAUSED') {
        this.activeMarkets.set(market.id, {
          id: market.id,
          title: market.title || market.question,
          question: market.question,
          decimalPrecision: market.decimalPrecision || AppConfig.decimalPrecisionDefault,
          isNegRisk: market.isNegRisk || false,
          isYieldBearing: market.isYieldBearing || false,
          feeRateBps: market.feeRateBps || 0,
          outcomes: (market.outcomes || []).map((o: any) => ({
            name: o.name,
            onChainId: o.onChainId,
            indexSet: o.indexSet,
          })),
        });
      }
    }

    console.log(`Active markets loaded: ${this.activeMarkets.size}`);
  }

  private async internalScan(): Promise<void> {
    if (!AppConfig.enableInternalArb) return;
    this.internalScanCount++;

    for (const [marketId, marketInfo] of this.activeMarkets) {
      if (this.isProcessing.has(marketId)) continue;

      try {
        const token = await this.jwtManager.getToken();
        const { data } = await axios.get(
          `${AppConfig.apiBaseUrl}/v1/markets/${marketId}/orderbook`,
          {
            headers: { Authorization: `Bearer ${token}`, 'x-api-key': AppConfig.apiKey },
            timeout: 10000,
          }
        );

        if (data.success && data.data) {
          await this.handleInternalOpportunity(data.data, marketInfo);
        }
      } catch {
        // skip failed markets
      }
    }
  }

  private async handleInternalOpportunity(
    book: OrderbookData,
    marketInfo: MarketInfo
  ): Promise<void> {
    const marketId = book.marketId;
    if (this.isProcessing.has(marketId)) return;
    this.isProcessing.add(marketId);

    try {
      const opportunity = this.detector.scanMarket(book, marketInfo);
      if (!opportunity) return;

      this.internalOpportunityCount++;

      const evaluation = await this.riskEngine.evaluate(opportunity);
      if (!evaluation.approved) {
        console.log(`[Internal] Market ${opportunity.marketId} rejected: ${evaluation.reason}`);
        return;
      }

      console.log(
        `[Internal] Opportunity: market=${opportunity.marketId}, ` +
        `type=${opportunity.type}, profitBps=${opportunity.profitBps}, ` +
        `qty=${opportunity.quantity}, netProfit=$${opportunity.netProfitUSDT.toFixed(4)}`
      );

      const result = await this.executor.executeOpportunity(opportunity, {
        isNegRisk: marketInfo.isNegRisk,
        isYieldBearing: marketInfo.isYieldBearing,
        feeRateBps: marketInfo.feeRateBps,
        outcomes: marketInfo.outcomes,
      });

      console.log(
        `[Internal] Result: success=${result.success}, ` +
        `netProfit=$${result.netProfitUSDT.toFixed(4)}, ` +
        `time=${result.executionTimeMs}ms`
      );

      this.todayTrades.push({
        timestamp: Date.now(),
        marketId: opportunity.marketId,
        marketTitle: marketInfo.title,
        type: opportunity.type,
        yesPrice: opportunity.yesBid,
        noPrice: opportunity.noBid,
        quantity: opportunity.quantity,
        estimatedProfit: opportunity.estimatedProfitUSDT,
        netProfit: result.netProfitUSDT,
        success: result.success,
        orderHashes: result.orders.map(o => o.orderHash),
        error: result.error,
      });
    } finally {
      this.isProcessing.delete(marketId);
    }
  }

  private async crossScan(): Promise<void> {
    if (!AppConfig.enableCrossArb || !this.crossCoordinator || !this.crossDetector || !this.crossMatcher || !this.pm) return;
    this.crossScanCount++;

    try {
      const allPfMarkets = await this.fetchAllMarkets();
      const activePfMarkets = allPfMarkets.filter((m: any) =>
        m.status === 'REGISTERED' || m.status === 'PRICE_PROPOSED' || m.status === 'UNPAUSED'
      );

      const [pmMarkets, pfMarkets] = await Promise.all([
        this.pm.getActiveMarkets(),
        Promise.resolve(activePfMarkets.map((m: any) => ({
            platform: 'PREDICTFUN' as const,
            id: m.id.toString(),
            slug: m.slug || '',
            title: m.title || '',
            question: m.title || m.question || '',
            outcomes: (m.outcomes || []).map((o: any) => o.name),
            tokenIds: {
              yes: (m.outcomes || [])[0]?.onChainId || '',
              no: (m.outcomes || [])[1]?.onChainId || '',
            },
            isNegRisk: m.isNegRisk || false,
            isYieldBearing: m.isYieldBearing || false,
            feeRateBps: m.feeRateBps || 0,
            tickSize: 0.01,
            status: 'ACTIVE',
            volume24h: parseFloat(m.volume24h || '0'),
            liquidity: parseFloat(m.liquidity || '0'),
            endDate: m.endTime ? new Date(m.endTime).getTime() : 0,
            resolutionSource: 'UMA',
          }))
        ),
      ]);

      this.crossPmMarkets = pmMarkets;
      this.crossPfMarkets = pfMarkets;
      this.crossMatchedEvents = await this.crossMatcher.buildMatchIndex(pmMarkets, pfMarkets);

      console.log(`[Cross] ${pmMarkets.length} PM markets, ${pfMarkets.length} PF markets, ${this.crossMatchedEvents.length} matches`);

      for (const match of this.crossMatchedEvents) {
        try {
          const pmOrderbook = await this.pm.getOrderbook(match.pmMarket.tokenIds.yes);
          const { data: pfBookData } = await axios.get(
            `${AppConfig.apiBaseUrl}/v1/markets/${match.pfMarket.id}/orderbook`,
            {
              headers: {
                Authorization: `Bearer ${await this.jwtManager.getToken()}`,
                'x-api-key': AppConfig.apiKey,
              },
              timeout: 10000,
            }
          );

          if (!pfBookData.success || !pfBookData.data) continue;

          const pfOrderbook = {
            platform: 'PREDICTFUN' as const,
            marketId: match.pfMarket.id,
            timestamp: pfBookData.data.updateTimestampMs,
            bids: (pfBookData.data.bids || []).map(([p, q]: [number, number]) => ({ price: p, size: q })),
            asks: (pfBookData.data.asks || []).map(([p, q]: [number, number]) => ({ price: p, size: q })),
            tickSize: 0.01,
          };

          const opportunity = await this.crossDetector.detectArbitrage(match, pmOrderbook, pfOrderbook);
          if (!opportunity) continue;

          console.log(
            `[Cross] Opportunity: ${match.pmMarket.title || match.pfMarket.title}, ` +
            `dir=${opportunity.bestDirection}, profitBps=${opportunity.bestProfitBps}, ` +
            `netProfit=$${opportunity.estimatedNetProfitUSDT.toFixed(4)}, score=${opportunity.score.toFixed(0)}`
          );

          if (opportunity.score < 60) {
            console.log(`[Cross] Score too low (${opportunity.score.toFixed(0)}), skipping`);
            continue;
          }

          const result = await this.crossCoordinator.executeAtomicArbitrage(opportunity);
          const trade = buildCrossTradeRecord(
            result,
            match.pmMarket.title || match.pfMarket.title,
            match.pmMarket.title,
            match.pfMarket.title
          );
          this.crossTodayTrades.push(trade);

          console.log(
            `[Cross] Result: success=${result.success}, ` +
            `hedged=${result.hedged}, netProfit=$${result.netProfitUSDT.toFixed(4)}`
          );
        } catch {
          // skip failed match
        }
      }
    } catch (error) {
      console.error('[Cross] Scan error:', error);
    }
  }

  private async sendDailyReport(): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    if (this.lastReportDate === today) {
      console.log('Today report already sent, skipping');
      return;
    }

    const internalSuccess = this.todayTrades.filter(t => t.success);
    const internalFailed = this.todayTrades.filter(t => !t.success);
    const internalProfit = internalSuccess.reduce((s, t) => s + t.estimatedProfit, 0);
    const internalNetProfit = internalSuccess.reduce((s, t) => s + t.netProfit, 0);

    const scanInfo = `共扫描 ${this.internalScanCount} 轮，发现 ${this.internalOpportunityCount} 次机会，执行 ${this.todayTrades.length} 笔`;

    const report: DailyReport = {
      date: today,
      totalTrades: this.todayTrades.length,
      successfulTrades: internalSuccess.length,
      totalEstimatedProfit: internalProfit,
      totalNetProfit: internalNetProfit,
      failedTrades: internalFailed.length,
      trades: this.todayTrades,
      summary: scanInfo,
      scanInfo,
    };

    console.log('========================================');
    console.log('Sending daily report to Notion...');
    console.log(`Date: ${report.date}`);
    console.log(`Internal: ${report.totalTrades} trades, $${report.totalNetProfit.toFixed(4)}`);
    console.log(`Cross: ${this.crossTodayTrades.length} trades`);

    try {
      await this.reporter.sendDailyReport(report, this.crossTodayTrades, this.crossScanCount, this.crossMatchedEvents.length);
      console.log('Daily report sent to Notion successfully');
      this.lastReportDate = today;
      this.resetDailyStats();
    } catch (error) {
      console.error('Failed to send daily report:', error);
    }
  }

  private resetDailyStats(): void {
    this.todayTrades = [];
    this.internalScanCount = 0;
    this.internalOpportunityCount = 0;
    this.crossTodayTrades = [];
    this.crossScanCount = 0;
  }

  private logHealth(): void {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const internalSuccess = this.todayTrades.filter(t => t.success).length;
    const internalProfit = this.todayTrades.filter(t => t.success).reduce((s, t) => s + t.netProfit, 0);
    const crossSuccess = this.crossTodayTrades.filter(t => t.success).length;

    let health = `[HEALTH] uptime=${hours}h${minutes}m, markets=${this.activeMarkets.size}`;

    if (AppConfig.enableInternalArb) {
      health += ` | int: scans=${this.internalScanCount}, opps=${this.internalOpportunityCount}, ` +
        `trades=${this.todayTrades.length}(${internalSuccess}ok), profit=$${internalProfit.toFixed(4)}`;
    }
    if (AppConfig.enableCrossArb) {
      health += ` | cross: scans=${this.crossScanCount}, matches=${this.crossMatchedEvents.length}, ` +
        `trades=${this.crossTodayTrades.length}(${crossSuccess}ok)`;
    }

    console.log(health);
  }
}

const service = new ArbitrageService();

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  service.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  service.stop();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

service.start().catch((error) => {
  console.error('Failed to start service:', error);
  process.exit(1);
});
