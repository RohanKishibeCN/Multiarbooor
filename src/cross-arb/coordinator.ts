import { CrossMarketOpportunity, CrossMarketExecutionResult, CrossTradeRecord } from './types';
import { PolymarketConnector } from './connectors/polymarket';
import { JWTManager } from '../auth/jwtManager';
import { OrderTracker } from '../tracker/orderTracker';
import { AppConfig } from '../config';

import { Side, OrderBuilder, ChainId } from '@predictdotfun/sdk';
import { Wallet, parseEther } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import axios from 'axios';

export class AtomicCoordinator {
  private pm: PolymarketConnector;
  private jwtManager: JWTManager;
  private tracker: OrderTracker;
  private pfOrderBuilder: OrderBuilder | null = null;
  private pfSigner: Wallet;

  constructor(pm: PolymarketConnector, jwtManager: JWTManager, tracker: OrderTracker) {
    this.pm = pm;
    this.jwtManager = jwtManager;
    this.tracker = tracker;
    this.pfSigner = new Wallet(AppConfig.walletPrivateKey);
  }

  setPfOrderBuilder(builder: OrderBuilder): void {
    this.pfOrderBuilder = builder;
  }

  async executeAtomicArbitrage(
    opportunity: CrossMarketOpportunity
  ): Promise<CrossMarketExecutionResult> {
    const startTime = Date.now();
    const dir = opportunity.bestDirection;
    const qty = opportunity.bestQuantity;

    let pmTokenId: string;
    let pmSide: 'BUY' | 'SELL';
    let pmPrice: number;
    let pfTokenId: string;
    let pfSide: 'BUY' | 'SELL';
    let pfPrice: number;

    if (dir === 'PM_YES_PF_NO') {
      pmTokenId = opportunity.event.pmMarket.tokenIds.yes;
      pmSide = 'BUY';
      pmPrice = opportunity.pmOrderbook.asks[0].price;
      pfTokenId = opportunity.event.pfMarket.tokenIds.yes;
      pfSide = 'BUY';
      pfPrice = parseFloat((1 - opportunity.pfOrderbook.bids[0].price).toFixed(4));
    } else {
      pmTokenId = opportunity.event.pmMarket.tokenIds.no;
      pmSide = 'BUY';
      pmPrice = opportunity.pmOrderbook.asks[0].price;
      pfTokenId = opportunity.event.pfMarket.tokenIds.yes;
      pfSide = 'BUY';
      pfPrice = opportunity.pfOrderbook.asks[0].price;
    }

    let pmOrderId = '';
    let pfOrderHash = '';
    let pmStatus = '';
    let pfStatus = '';

    try {
      const pmResult = await this.executePMOrder(pmTokenId, pmSide, pmPrice, qty);
      pmOrderId = pmResult.orderId;
      pmStatus = pmResult.status;
    } catch (err) {
      pmStatus = 'FAILED';
    }

    try {
      const pfResult = await this.executePFOrder(pfTokenId, pfSide, pfPrice, qty,
        opportunity.event.pfMarket.isNegRisk, opportunity.event.pfMarket.isYieldBearing);
      pfOrderHash = pfResult.orderHash;
      pfStatus = pfResult.status;
    } catch (err) {
      pfStatus = 'FAILED';
    }

    if (!pmOrderId && !pfOrderHash) {
      return {
        success: false, opportunity, pmOrderId: '', pfOrderHash: '',
        pmStatus: 'FAILED', pfStatus: 'FAILED', hedged: false,
        netProfitUSDT: 0, executionTimeMs: Date.now() - startTime, error: 'Both orders failed',
      };
    }

    if (pmOrderId && !pfOrderHash) {
      return {
        success: false, opportunity, pmOrderId, pfOrderHash: '',
        pmStatus, pfStatus: 'FAILED', hedged: false,
        netProfitUSDT: 0, executionTimeMs: Date.now() - startTime, error: 'PF order failed, PM executed',
      };
    }

    if (!pmOrderId && pfOrderHash) {
      try {
        await this.tracker.cancelOrders([pfOrderHash]);
      } catch { }
      return {
        success: false, opportunity, pmOrderId: '', pfOrderHash,
        pmStatus: 'FAILED', pfStatus, hedged: false,
        netProfitUSDT: 0, executionTimeMs: Date.now() - startTime, error: 'PM order failed, PF cancelled',
      };
    }

    let pmFilled = pmStatus === 'FILLED';
    let pfFilled = pfStatus === 'FILLED';

    if (pmStatus === 'PENDING') {
      try {
        const pmFill = await this.tracker.waitForFill(pmOrderId, AppConfig.crossExecutionTimeoutMs);
        pmFilled = true;
      } catch { }
    }
    if (pfStatus === 'PENDING') {
      try {
        const pfFill = await this.tracker.waitForFill(pfOrderHash, AppConfig.crossExecutionTimeoutMs);
        pfFilled = true;
      } catch { }
    }

    let hedged = false;
    const bothFilled = pmFilled && pfFilled;

    if (!bothFilled) {
      if (pmFilled && !pfFilled) {
        hedged = true;
        try {
          await this.tracker.cancelOrders([pfOrderHash]);
        } catch { }
      } else if (!pmFilled && pfFilled) {
        hedged = true;
        try {
          await this.tracker.cancelOrders([pfOrderHash]);
        } catch { }
      } else {
        try {
          if (pmOrderId) await this.tracker.cancelOrders([pmOrderId]);
          if (pfOrderHash) await this.tracker.cancelOrders([pfOrderHash]);
        } catch { }
      }
    }

    return {
      success: bothFilled,
      opportunity,
      pmOrderId,
      pfOrderHash,
      pmStatus: pmFilled ? 'FILLED' : 'CANCELLED',
      pfStatus: pfFilled ? 'FILLED' : 'CANCELLED',
      hedged,
      netProfitUSDT: bothFilled ? opportunity.estimatedNetProfitUSDT : 0,
      executionTimeMs: Date.now() - startTime,
    };
  }

  private async executePMOrder(
    tokenId: string,
    side: string,
    price: number,
    size: number
  ): Promise<{ orderId: string; status: string }> {
    if (!AppConfig.polymarketPrivateKey) {
      return { orderId: '', status: 'FAILED' };
    }

    const account = privateKeyToAccount(AppConfig.polymarketPrivateKey as `0x${string}`);
    const client = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const { ClobClient } = await import('@polymarket/clob-client');
    const tempClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      client as any
    );

    const apiCreds = await tempClient.createOrDeriveApiKey();
    const clobClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      client as any,
      apiCreds,
      3 as any,
      AppConfig.polymarketFunderAddress || undefined
    );

    const order = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: side as any,
      },
      { tickSize: '0.01', negRisk: false }
    );

    return {
      orderId: order.orderID || order.id || '',
      status: order.status || 'PENDING',
    };
  }

  private async executePFOrder(
    tokenId: string,
    side: string,
    price: number,
    size: number,
    isNegRisk: boolean,
    isYieldBearing: boolean
  ): Promise<{ orderHash: string; status: string }> {
    if (!this.pfOrderBuilder) throw new Error('PF OrderBuilder not initialized');

    if (!tokenId) {
      return { orderHash: '', status: 'FAILED' };
    }

    const sideEnum = side === 'BUY' ? Side.BUY : Side.SELL;
    const { makerAmount, takerAmount, pricePerShare } =
      this.pfOrderBuilder.getLimitOrderAmounts({
        side: sideEnum,
        pricePerShareWei: parseEther(price.toString()),
        quantityWei: parseEther(size.toString()),
      });

    const order = this.pfOrderBuilder.buildOrder('LIMIT', {
      maker: this.pfSigner.address,
      signer: this.pfSigner.address,
      side: sideEnum,
      tokenId,
      makerAmount,
      takerAmount,
      nonce: 0n,
      feeRateBps: 0,
    });

    const typedData = this.pfOrderBuilder.buildTypedData(order, {
      isNegRisk,
      isYieldBearing,
    });

    const signedOrder = await this.pfOrderBuilder.signTypedDataOrder(typedData);
    const hash = this.pfOrderBuilder.buildTypedDataHash(typedData);
    const token = await this.jwtManager.getToken();

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
          Authorization: `Bearer ${token}`,
          'x-api-key': AppConfig.apiKey,
        },
        timeout: AppConfig.orderTimeoutMs,
      }
    );

    if (!data.success || !data.data) {
      throw new Error(`Failed to create PF order: ${JSON.stringify(data)}`);
    }

    return {
      orderHash: data.data.orderHash,
      status: 'PENDING',
    };
  }
}

export function buildCrossTradeRecord(
  result: CrossMarketExecutionResult,
  eventTitle: string,
  pmMarketTitle: string,
  pfMarketTitle: string
): CrossTradeRecord {
  return {
    timestamp: Date.now(),
    eventTitle,
    pmMarketTitle,
    pfMarketTitle,
    direction: result.opportunity.bestDirection,
    quantity: result.opportunity.bestQuantity,
    pmPrice: result.opportunity.pmOrderbook.asks[0]?.price || 0,
    pfPrice: result.opportunity.pfOrderbook.asks[0]?.price || 0,
    estimatedProfit: result.opportunity.estimatedNetProfitUSDT,
    netProfit: result.netProfitUSDT,
    success: result.success,
    hedged: result.hedged,
    error: result.error,
  };
}
