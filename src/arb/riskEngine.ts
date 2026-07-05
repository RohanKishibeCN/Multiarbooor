import axios from 'axios';
import { ArbitrageOpportunity } from './types';
import { AppConfig } from '../config';
import { JWTManager } from '../auth/jwtManager';

interface PositionEntry {
  marketId: number;
  size: number;
}

export class RiskEngine {
  private jwtManager: JWTManager;

  constructor(jwtManager: JWTManager) {
    this.jwtManager = jwtManager;
  }

  async evaluate(opp: ArbitrageOpportunity): Promise<{
    approved: boolean;
    adjustedQuantity: number;
    netProfitUSDT: number;
    reason?: string;
  }> {
    if (opp.netProfitUSDT <= 0) {
      return {
        approved: false,
        adjustedQuantity: 0,
        netProfitUSDT: 0,
        reason: `净利润为负或为零: ${opp.netProfitUSDT.toFixed(4)} USDT`,
      };
    }

    const positions = await this.getCurrentPositions();
    const marketExposure = positions
      .filter(p => p.marketId === opp.marketId)
      .reduce((sum, p) => sum + p.size, 0);

    if (marketExposure + opp.quantity > AppConfig.maxPositionPerMarket) {
      return {
        approved: false,
        adjustedQuantity: 0,
        netProfitUSDT: 0,
        reason: `超出单市场最大敞口: ${AppConfig.maxPositionPerMarket}`,
      };
    }

    const totalExposure = positions.reduce((sum, p) => sum + p.size, 0);
    if (totalExposure + opp.quantity * 2 > AppConfig.maxTotalExposure) {
      return {
        approved: false,
        adjustedQuantity: 0,
        netProfitUSDT: 0,
        reason: `超出总敞口限制: ${AppConfig.maxTotalExposure}`,
      };
    }

    const slippageDiscount = (AppConfig.maxSlippageBps / 10000) * opp.quantity;
    const netProfit = opp.estimatedProfitUSDT - slippageDiscount - opp.estimatedGasUSDT;

    if (netProfit <= 0) {
      return {
        approved: false,
        adjustedQuantity: 0,
        netProfitUSDT: 0,
        reason: `考虑滑点后净利润为负: ${netProfit.toFixed(4)} USDT`,
      };
    }

    return {
      approved: true,
      adjustedQuantity: opp.quantity,
      netProfitUSDT: parseFloat(netProfit.toFixed(4)),
    };
  }

  private async getCurrentPositions(): Promise<PositionEntry[]> {
    try {
      const token = await this.jwtManager.getToken();
      const { data } = await axios.get(`${AppConfig.apiBaseUrl}/v1/positions`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': AppConfig.apiKey,
        },
      });

      if (!data.success || !data.data) return [];

      return data.data.map((p: any) => ({
        marketId: p.marketId,
        size: parseFloat(p.size || '0'),
      }));
    } catch {
      return [];
    }
  }
}
