import axios, { AxiosInstance } from 'axios';
import { Wallet } from 'ethers';
import type { OrderBuilder } from '@predictdotfun/sdk';
import { AppConfig, isUsingPredictAccount, getSignerPrivateKey } from '../config';

interface JWTState {
  token: string;
  expiresAt: number;
}

export class JWTManager {
  private state: JWTState | null = null;
  private wallet: Wallet;
  private http: AxiosInstance;
  private orderBuilder: OrderBuilder | null = null;

  constructor() {
    this.wallet = new Wallet(getSignerPrivateKey());
    this.http = axios.create({
      baseURL: AppConfig.apiBaseUrl,
      headers: { 'x-api-key': AppConfig.apiKey },
      timeout: 15000,
    });
  }

  setOrderBuilder(builder: OrderBuilder): void {
    this.orderBuilder = builder;
  }

  getWalletAddress(): string {
    return isUsingPredictAccount() ? AppConfig.predictAccountAddress : this.wallet.address;
  }

  getPrivateKeyAddress(): string {
    return this.wallet.address;
  }

  async getToken(): Promise<string> {
    if (this.state && Date.now() < this.state.expiresAt - 120000) {
      return this.state.token;
    }
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string> {
    const { data: msgResp } = await this.http.get('/v1/auth/message');
    if (!msgResp.success || !msgResp.data?.message) {
      throw new Error('Failed to get auth message: ' + JSON.stringify(msgResp));
    }

    const message = msgResp.data.message;

    let signature: string;
    let signer: string;

    if (isUsingPredictAccount()) {
      if (!this.orderBuilder) {
        throw new Error(
          'Predict Account mode requires OrderBuilder. ' +
          'Call jwtManager.setOrderBuilder() before getToken().'
        );
      }
      signature = await this.orderBuilder.signPredictAccountMessage(message);
      signer = AppConfig.predictAccountAddress;
    } else {
      signature = await this.wallet.signMessage(message);
      signer = this.wallet.address;
    }

    const { data: jwtResp } = await this.http.post('/v1/auth', {
      signer,
      signature,
      message,
    });

    if (!jwtResp.success || !jwtResp.data?.token) {
      throw new Error('Failed to get JWT token: ' + JSON.stringify(jwtResp));
    }

    this.state = {
      token: jwtResp.data.token,
      expiresAt: Date.now() + 55 * 60 * 1000,
    };

    return this.state.token;
  }

  resetToken(): void {
    this.state = null;
  }
}
