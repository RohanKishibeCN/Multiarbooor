import axios from 'axios';
import { OrderBuilder, Side, ChainId } from '@predictdotfun/sdk';
import { Wallet, parseEther } from 'ethers';
import { AppConfig } from '../config';
import { JWTManager } from '../auth/jwtManager';
import { ArbitrageOpportunity, ExecutionResult, OrderResult } from '../arb/types';
import { OrderTracker } from '../tracker/orderTracker';

export class TradeExecutor {
  private orderBuilder: OrderBuilder | null = null;
  private jwtManager: JWTManager;
  private signer: Wallet;
  private tracker: OrderTracker;
  private nonceCounter: bigint;

  constructor(jwtManager: JWTManager, tracker: OrderTracker) {
    this.jwtManager = jwtManager;
    this.tracker = tracker;
    this.signer = new Wallet(AppConfig.walletPrivateKey);
    this.nonceCounter = BigInt(Math.floor(Date.now() / 1000));
  }

  async initialize(): Promise<void> {
    this.orderBuilder = await OrderBuilder.make(
      ChainId.BnbMainnet,
      this.signer,
      { predictAccount: this.signer.address }
    );
  }

  async executeOpportunity(
    opp: ArbitrageOpportunity,
    marketInfo: {
      isNegRisk: boolean;
      isYieldBearing: boolean;
      feeRateBps: number;
      outcomes: { name: string; onChainId: string; indexSet: number }[];
    }
  ): Promise<ExecutionResult> {
    if (!this.orderBuilder) throw new Error('OrderBuilder not initialized');
    if (marketInfo.outcomes.length < 2) throw new Error('Market requires 2 outcomes');

    const token = await this.jwtManager.getToken();
    const results: OrderResult[] = [];
    const startTime = Date.now();
    const feeRate = marketInfo.feeRateBps || 0;
    const yesTokenId = marketInfo.outcomes[0].onChainId;
    const noTokenId = marketInfo.outcomes[1].onChainId;

    try {
      if (opp.type === 'SELL_BOTH') {
        const yesResult = await this.submitLimitOrder(
          Side.SELL, yesTokenId, opp.yesBid, opp.quantity,
          marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'YES'
        );
        results.push(yesResult);

        const noResult = await this.submitLimitOrder(
          Side.SELL, noTokenId, opp.noBid, opp.quantity,
          marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'NO'
        );
        results.push(noResult);
      } else {
        const yesResult = await this.submitLimitOrder(
          Side.BUY, yesTokenId, opp.yesAsk, opp.quantity,
          marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'YES'
        );
        results.push(yesResult);

        const noResult = await this.submitLimitOrder(
          Side.BUY, noTokenId, opp.noAsk, opp.quantity,
          marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'NO'
        );
        results.push(noResult);
      }

      const settled = await Promise.allSettled(
        results.map(r => this.tracker.waitForFill(r.orderHash, AppConfig.orderTimeoutMs))
      );

      const finalResults: OrderResult[] = [];
      let allFilled = true;

      for (let i = 0; i < settled.length; i++) {
        const sr = settled[i];
        if (sr.status === 'fulfilled') {
          finalResults.push({
            ...results[i],
            status: 'FILLED',
            filledQuantity: sr.value.filledQuantity,
            filledPrice: sr.value.filledPrice,
          });
        } else {
          allFilled = false;
          finalResults.push(results[i]);
        }
      }

      if (!allFilled) {
        const hashesToCancel = finalResults
          .filter(r => r.status !== 'FILLED')
          .map(r => r.orderHash);
        await this.tracker.cancelOrders(hashesToCancel);
      }

      return {
        success: allFilled,
        opportunity: opp,
        orders: finalResults,
        netProfitUSDT: allFilled ? opp.netProfitUSDT : 0,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        opportunity: opp,
        orders: results,
        netProfitUSDT: 0,
        executionTimeMs: Date.now() - startTime,
        error: errorMsg,
      };
    }
  }

  private async submitLimitOrder(
    side: Side,
    tokenId: string,
    price: number,
    quantity: number,
    isNegRisk: boolean,
    isYieldBearing: boolean,
    feeRateBps: number,
    jwtToken: string,
    outcome: 'YES' | 'NO'
  ): Promise<OrderResult> {
    if (!this.orderBuilder) throw new Error('OrderBuilder not initialized');

    const pricePerShareWei = parseEther(price.toString());
    const quantityWei = parseEther(quantity.toString());

    const { makerAmount, takerAmount, pricePerShare } =
      this.orderBuilder.getLimitOrderAmounts({
        side,
        pricePerShareWei,
        quantityWei,
      });

    const order = this.orderBuilder.buildOrder('LIMIT', {
      maker: this.signer.address,
      signer: this.signer.address,
      side,
      tokenId,
      makerAmount,
      takerAmount,
      nonce: this.getNextNonce(),
      feeRateBps: feeRateBps,
    });

    const typedData = this.orderBuilder.buildTypedData(order, {
      isNegRisk,
      isYieldBearing,
    });

    const signedOrder = await this.orderBuilder.signTypedDataOrder(typedData);
    const hash = this.orderBuilder.buildTypedDataHash(typedData);

    const { data } = await axios.post(
      `${AppConfig.apiBaseUrl}/v1/orders`,
      {
        data: {
          order: { ...signedOrder, hash },
          pricePerShare,
          strategy: 'LIMIT',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'x-api-key': AppConfig.apiKey,
        },
        timeout: AppConfig.orderTimeoutMs,
      }
    );

    if (!data.success || !data.data) {
      throw new Error(`Failed to create order: ${JSON.stringify(data)}`);
    }

    return {
      side: side === Side.SELL ? 'SELL' : 'BUY',
      outcome,
      orderHash: data.data.orderHash,
      orderId: data.data.orderId,
      status: 'PENDING',
      filledQuantity: 0,
      filledPrice: 0,
    };
  }

  private getNextNonce(): bigint {
    this.nonceCounter += 1n;
    return this.nonceCounter;
  }
}
