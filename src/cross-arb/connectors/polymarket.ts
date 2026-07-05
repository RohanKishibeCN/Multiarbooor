import axios from 'axios';
import { UnifiedMarket, UnifiedOrderbook, Platform } from '../types';
import { AppConfig } from '../../config';

export class PolymarketConnector {
  private gammaBaseUrl = 'https://gamma-api.polymarket.com';
  private clobBaseUrl = 'https://clob.polymarket.com';

  async getActiveMarkets(): Promise<UnifiedMarket[]> {
    const { data } = await axios.get(`${this.gammaBaseUrl}/markets`, {
      params: { closed: false, limit: 500 },
      timeout: 15000,
    });

    return (data || []).map((m: any) => ({
      platform: 'POLYMARKET' as Platform,
      id: m.conditionId || '',
      slug: m.slug || '',
      title: m.title || '',
      question: m.question || '',
      outcomes: m.outcomes || [],
      tokenIds: {
        yes: m.clobTokenIds?.[0] || m.tokens?.[0]?.tokenId || '',
        no: m.clobTokenIds?.[1] || m.tokens?.[1]?.tokenId || '',
      },
      isNegRisk: m.negRisk || false,
      isYieldBearing: false,
      feeRateBps: 0,
      tickSize: parseFloat(m.tickSize || '0.01'),
      status: m.closed ? 'CLOSED' : 'ACTIVE',
      volume24h: m.volume24hr || 0,
      liquidity: parseFloat(m.liquidity || '0'),
      endDate: m.endDateIso ? new Date(m.endDateIso).getTime() : 0,
      resolutionSource: m.resolutionSource || 'UMA',
    }));
  }

  async getEvents(): Promise<any[]> {
    const { data } = await axios.get(`${this.gammaBaseUrl}/events`, {
      params: { limit: 500, active: true, closed: false },
      timeout: 15000,
    });
    return data || [];
  }

  async getOrderbook(tokenId: string): Promise<UnifiedOrderbook> {
    const { data } = await axios.get(`${this.clobBaseUrl}/book`, {
      params: { token_id: tokenId },
      timeout: 10000,
    });

    return {
      platform: 'POLYMARKET',
      marketId: tokenId,
      timestamp: Date.now(),
      bids: (data.bids || []).map((b: any) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      })),
      asks: (data.asks || []).map((a: any) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      })),
      tickSize: parseFloat(data.tick_size || '0.01'),
    };
  }

  async getBalance(): Promise<number> {
    if (!AppConfig.polymarketFunderAddress) return 0;
    try {
      const { data } = await axios.get(`${this.clobBaseUrl}/balance`, {
        params: { address: AppConfig.polymarketFunderAddress },
        timeout: 10000,
      });
      return parseFloat(data.balance || '0');
    } catch {
      return 0;
    }
  }
}
