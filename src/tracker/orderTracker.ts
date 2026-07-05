import axios from 'axios';
import { AppConfig } from '../config';
import { JWTManager } from '../auth/jwtManager';

export interface OrderStatus {
  hash: string;
  status: 'PENDING' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'EXPIRED';
  filledQuantity: number;
  filledPrice: number;
}

export class OrderTracker {
  private jwtManager: JWTManager;

  constructor(jwtManager: JWTManager) {
    this.jwtManager = jwtManager;
  }

  async getOrderStatus(hash: string): Promise<OrderStatus> {
    const token = await this.jwtManager.getToken();
    const { data } = await axios.get(
      `${AppConfig.apiBaseUrl}/v1/orders/${hash}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': AppConfig.apiKey,
        },
      }
    );

    if (!data.success || !data.data) {
      throw new Error(`Failed to get order status: ${JSON.stringify(data)}`);
    }

    const order = data.data;
    return {
      hash,
      status: order.status || 'PENDING',
      filledQuantity: parseFloat(order.filledQuantity || '0'),
      filledPrice: parseFloat(order.avgPrice || '0'),
    };
  }

  async waitForFill(hash: string, timeoutMs: number = AppConfig.orderTimeoutMs): Promise<OrderStatus> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const status = await this.getOrderStatus(hash);

        if (status.status === 'FILLED') {
          return status;
        }
        if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
          throw new Error(`Order ${hash} status: ${status.status}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('status: CANCELLED')) {
          throw error;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Order ${hash} timeout after ${timeoutMs}ms`);
  }

  async cancelOrders(hashes: string[]): Promise<void> {
    try {
      const token = await this.jwtManager.getToken();
      await axios.delete(`${AppConfig.apiBaseUrl}/v1/orders`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': AppConfig.apiKey,
        },
        data: { data: { hashes } },
      });
    } catch (error) {
      console.error(`Failed to cancel orders:`, error);
    }
  }
}
