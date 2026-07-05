import axios, { AxiosInstance } from 'axios';
import { Wallet } from 'ethers';
import { AppConfig } from '../config';

interface JWTState {
  token: string;
  expiresAt: number;
}

export class JWTManager {
  private state: JWTState | null = null;
  private wallet: Wallet;
  private http: AxiosInstance;

  constructor() {
    this.wallet = new Wallet(AppConfig.walletPrivateKey);
    this.http = axios.create({
      baseURL: AppConfig.apiBaseUrl,
      headers: { 'x-api-key': AppConfig.apiKey },
      timeout: 15000,
    });
  }

  getWalletAddress(): string {
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
    const signature = await this.wallet.signMessage(message);

    const { data: jwtResp } = await this.http.post('/v1/auth', {
      signer: this.wallet.address,
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
}
