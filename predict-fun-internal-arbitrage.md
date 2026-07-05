# Predict.fun 平台内套利方案

## 目录

1. [第一性原理与套利理论基础](#1-第一性原理与套利理论基础)
2. [套利策略详解](#2-套利策略详解)
3. [系统架构设计](#3-系统架构设计)
4. [代码实现](#4-代码实现)
5. [风险控制与监控](#5-风险控制与监控)
6. [部署与运维](#6-部署与运维)

---

## 1. 第一性原理与套利理论基础

### 1.1 Predict.fun 核心机制

Predict.fun 基于 **Conditional Token Framework (CTF)** 构建于 BNB Chain，采用 **CLOB (Central Limit Order Book)** 撮合引擎。

每个二元市场有两类结果代币（Outcome Tokens）：

```
Yes Token + No Token = 1 USDT（到期时）
```

- **Yes Token**：事件发生时支付 1 USDT
- **No Token**：事件不发生时支付 1 USDT

价格区间 `[0, 1]`，精度由市场 `decimalPrecision` 决定（通常为 2 位小数，即最小粒度 0.01）。

### 1.2 订单簿结构

API 返回的订单簿**基于 Yes 侧**定价：

```json
{
  "data": {
    "marketId": 1,
    "asks": [[0.492, 30192.26], [0.493, 20003]],
    "bids": [[0.491, 303518.1], [0.49, 1365.44]]
  }
}
```

**No 侧价格转换公式**（文档原始）：

```javascript
const getComplement = (price, decimalPrecision = 2) => {
  const factor = 10 ** decimalPrecision;
  return (factor - Math.round(price * factor)) / factor;
};
```

转换关系：

| Yes 侧 | No 侧推导 |
|--------|-----------|
| `asks[0][0]`（最低 Yes 卖价） | No Bid = `getComplement(asks[0][0])` |
| `bids[0][0]`（最高 Yes 买价） | No Ask = `getComplement(bids[0][0])` |
| 完整 No bids | `yesAsks.map([p,q] => [getComplement(p), q])` |
| 完整 No asks | `yesBids.map([p,q] => [getComplement(p), q])` |

### 1.3 套利空间的第一性原理推导

在无摩擦的理想市场中，应有恒等式：

```
Yes 最高买价 + No 最高买价 = 1.00
Yes 最低卖价 + No 最低卖价 = 1.00
```

但实际 CLOC 中存在交易者行为偏差，导致：

```
Sum_Bid = 1.00 + ε   或   Sum_Bid = 1.00 - ε
Sum_Ask = 1.00 + ε   或   Sum_Ask = 1.00 - ε
```

**当 `Sum_Bid > 1.00` 时**：同时按 Best Bid 卖出 Yes 和 No，收入 > 1.00，到期最大支付为 1.00，无风险利润 = Sum_Bid - 1.00。

**当 `Sum_Ask < 1.00` 时**：同时按 Best Ask 买入 Yes 和 No，成本 < 1.00，到期必然收回 1.00，无风险利润 = 1.00 - Sum_Ask。

### 1.4 利润模型

```
利润 = |Sum_{side} - 1.00| × Q - Fees - Gas

其中：
  Sum_{side} = bestBid_yes + bestBid_no  或  bestAsk_yes + bestAsk_no
  Q = 执行数量（shares）
  Fees = Predict.fun 平台手续费
  Gas = BNB Chain交易费
```

**费用估算（BNB Chain）**：
- 合约交互 Gas：约 0.0005-0.001 BNB/笔（~$0.30-$0.60）
- 平台手续费：参考 Polymarket 同类模型，预估 0-5bps
- **最小套利规模**：建议每次 ≥ $50 以覆盖费用

### 1.5 统一订单簿模型的第一性原理验证（⭐ 新增）

#### 1.5.1 订单簿的核心机制

根据 Predict.fun 官方文档 [Understanding the Orderbook](https://dev.predict.fun/understanding-the-orderbook-685654m0.md)：

> **The order book stores prices based on the `Yes` outcome.**

API 返回的订单簿**始终基于 Yes 侧定价**，但这并不意味着只有 Yes Token 可交易。API Schema 中明确存在 `OutcomeSide: 'Yes' | 'No'` 枚举和 `lastOrderSettled.outcome` 字段，证明 **Yes 和 No Token 均可独立挂单和成交**。

关键洞察：**Predict.fun 的订单簿是一个「统一订单簿」（Unified Orderbook）**，所有订单（无论交易 Yes 还是 No）都被归一化到 Yes 定价后合并展示：

```
统一订单簿（Yes 定价视角）：
┌─────────────────────────────────────────────────┐
│ bids（买盘） = 直接 BUY Yes  +  转化 SELL No     │
│ asks（卖盘） = 直接 SELL Yes +  转化 BUY No      │
└─────────────────────────────────────────────────┘
```

转化规则：当用户挂 SELL No @ P_no 时，系统自动转化为 bids 中的 `complement(P_no)` 条目（相当于一个合成 BUY Yes）；当用户挂 BUY No @ P_no 时，转化为 asks 中的 `complement(P_no)` 条目（相当于一个合成 SELL Yes）。

#### 1.5.2 套利可行性的严格数学证明

**前提：** 统一订单簿中包含两种来源的订单——直接 Yes 订单和转化后的 No 订单。

**SELL_BOTH 可行性的严格推导：**

设当前统一订单簿中：
- `bestBid` = max(直接 BUY Yes 价格, complement(直接 SELL No 价格))
- `bestAsk` = min(直接 SELL Yes 价格, complement(直接 BUY No 价格))
- 推导 No 侧: `bestNoBid = complement(bestAsk)`, `bestNoAsk = complement(bestBid)`

SELL_BOTH 套利条件：`sumBid = bestBid + bestNoBid = bestBid + complement(bestAsk) > 1`

**情况 A：** bestBid 来自直接 BUY Yes @ P_yes_buy，bestAsk 来自直接 SELL Yes @ P_yes_sell
```
sumBid = P_yes_buy + complement(P_yes_sell)
       = P_yes_buy + (1 - P_yes_sell)    （忽略小数精度）
```
正常市场中 P_yes_buy < P_yes_sell（bid < ask），因此：
```
sumBid < P_yes_sell + (1 - P_yes_sell) = 1
```
❌ **同源订单簿（纯 Yes 直接订单）不可能产生套利！**

**情况 B：** bestBid 来自转化 SELL No @ P_no_sell（即 bestBid = complement(P_no_sell)），bestAsk 来自直接 SELL Yes @ P_yes_sell
```
sumBid = complement(P_no_sell) + complement(P_yes_sell)
       = (1 - P_no_sell) + (1 - P_yes_sell)
       = 2 - (P_no_sell + P_yes_sell)
```
套利条件：`2 - (P_no_sell + P_yes_sell) > 1 → P_no_sell + P_yes_sell < 1`

✅ **当直接 SELL No 价格 + 直接 SELL Yes 价格 < 1 时，套利成立！**

**实例：**
```
用户A：SELL No  @ 0.30 → 转化为 bids 条目 [complement(0.30) = 0.70, qty]
用户B：SELL Yes @ 0.40 → 出现在 asks 条目 [0.40, qty]

统一订单簿：
  bids:  [0.70, 100]  ← 来自用户A的 SELL No
  asks:  [0.40, 100]  ← 来自用户B的 SELL Yes

套利检测：
  bestBid = 0.70, bestAsk = 0.40
  noBid = complement(0.40) = 0.60, noAsk = complement(0.70) = 0.30
  sumBid = 0.70 + 0.60 = 1.30 > 1.00 ✅
  sumAsk = 0.40 + 0.30 = 0.70 < 1.00 ✅
  两个方向同时存在套利空间！利润 = 0.30 / share
```

#### 1.5.3 执行机制的正确映射

**SELL_BOTH 执行（sumBid > 1）：**

| 腿 | 订单 | Token | 价格 | 匹配对手 | 现金流 | 到期负债 |
|----|------|-------|------|----------|--------|----------|
| 1 | SELL | Yes TokenId | bestBid | 转化 SELL No 用户 | +bestBid | 欠 1 Yes（若 Yes 胜） |
| 2 | SELL | No TokenId | bestNoBid | 直接 SELL Yes 用户（通过引擎转化匹配） | +bestNoBid | 欠 1 No（若 No 胜） |
| **净** | | | | | **+bestBid + bestNoBid** | **必然欠 1（仅一方胜）** |

**BUY_BOTH 执行（sumAsk < 1）：**

| 腿 | 订单 | Token | 价格 | 匹配对手 | 现金流 | 到期资产 |
|----|------|-------|------|----------|--------|----------|
| 1 | BUY | Yes TokenId | bestAsk | 直接 SELL Yes 用户 | -bestAsk | 1 Yes Token |
| 2 | BUY | No TokenId | bestNoAsk | 转化 BUY Yes 用户（通过引擎转化匹配） | -bestNoAsk | 1 No Token |
| **净** | | | | | **-(bestAsk + bestNoAsk)** | **1 Yes + 1 No → 可赎回 1 USDT** |

**关键约束：** SELL_BOTH 中的第 2 腿（SELL No）提交后，引擎会将其转化为 `BUY Yes @ complement(bestNoBid) = bestAsk` 并在统一订单簿中匹配。该转化由 Predict.fun CLOB 引擎自动完成，对调用方透明。

#### 1.5.4 套利存在性的必要条件总结

| 套利类型 | 必要条件 | 市场含义 |
|----------|----------|----------|
| SELL_BOTH (sumBid > 1) | 存在独立的 SELL No 订单，且其价格与 SELL Yes 价格之和 < 1 | No 卖方定价过低 + Yes 卖方定价也相对低 |
| BUY_BOTH (sumAsk < 1) | 存在独立的 BUY No 订单，且其价格与 BUY Yes 价格之和 > 1 | No 买方出价过高 + Yes 买方出价也相对高 |

**结论：** 套利存在的前提是订单簿中存在来源异构的挂单（即有直接的 No 侧订单混入统一订单簿）。若所有挂单均为直接 Yes 侧订单，则 `bestBid < bestAsk` 恒成立，套利数学上不可能。**因此该策略的实际收益能力取决于 Predict.fun 平台上 No 侧直接挂单的活跃度。**

---

## 2. 套利策略详解

### 2.1 策略 A：Yes/No 互补性套利（核心策略）

**触发条件**：

```
// 卖出套利（收益 > 成本）
bestBid_yes + getComplement(bestAsk_yes, precision) > 1.00 + threshold

// 买入套利（成本 < 收益）
bestAsk_yes + getComplement(bestBid_yes, precision) < 1.00 - threshold
```

**执行流程（修正版）**：

```
1. 获取统一订单簿（Yes 定价视图）→ 计算 Sum_Bid / Sum_Ask
2. 若 Sum_Bid > 1.00 + threshold:
   → 腿1: SELL Yes Token  (tokenId=outcomes[0].onChainId, 价格=bestBid)
   → 腿2: SELL No  Token  (tokenId=outcomes[1].onChainId, 价格=bestNoBid)
   → 引擎自动将腿2转化为 BUY Yes @ complement(bestNoBid) 并匹配
3. 若 Sum_Ask < 1.00 - threshold:
   → 腿1: BUY  Yes Token  (tokenId=outcomes[0].onChainId, 价格=bestAsk)
   → 腿2: BUY  No  Token  (tokenId=outcomes[1].onChainId, 价格=bestNoAsk)
   → 引擎自动将腿2转化为 SELL Yes @ complement(bestNoAsk) 并匹配
4. 确认两笔订单均成交（waitForFill 并行等待）
5. 监控市场状态，到期后通过 CTF 合约赎回 WIN token = 1 USDT × Q
```

**阈值修正**：

原方案阈值 `0.005`（0.5% = 50 bps）严重偏低。实际成本分析如下：

```
最小盈利交易成本 = 2 × 提交订单 Gas + 2 × 取消订单 Gas（部分成交时）+ 赎回 Gas

单笔交易 Gas: ~0.0003-0.0008 BNB × $600/BNB = $0.18-$0.48
4-5 笔交易（最坏情况）: $0.72-$2.40
平台手续费: 若 market.feeRateBps ≠ 0，则 2 腿均产生费用

实际门槛计算:
  设 minProfitUSDT = 5.00（最小期望利润）
  设 quantity = min(bestBid_qty, bestAsk_qty)
  利润 = (sumBid - 1) × quantity - fees - gas
  
  → 需要的 sumBid - 1 = (minProfitUSDT + fees + gas) / quantity
  → threshold = max(0.005, required_spread)
  
  示例：quantity = $500, gas = $1.5, fee = $1 (10bps×2腿×$500)
  → 需要 spread = ($5 + $1.5 + $1) / $500 = 0.015 = 1.5% = 150 bps
```

**动态阈值公式**：

```typescript
function computeRequiredThreshold(quantity: number, gasCostUSDT: number, feeRateBps: number): number {
  const feeCostUSDT = quantity * (feeRateBps / 10000) * 2; // 两腿
  const minProfit = Math.max(5, (gasCostUSDT + feeCostUSDT) * 2); // 至少覆盖2x成本
  const requiredSpread = (minProfit + gasCostUSDT + feeCostUSDT) / quantity;
  return Math.max(0.005, requiredSpread);
}
```

> ⚠️ **建议生产环境使用 `MIN_PROFIT_BPS=150` 作为起始值，再根据实盘数据调整。** 50 bps 仅适用于大单（$1000+）和低 Gas 时段。

### 2.2 策略 B：订单簿流动性套利

当订单簿深度在 Yes 和 No 两侧不对称时，存在跨深度套利：

```
示例：
  Yes asks: [[0.50, 100], [0.55, 200]]
  No 衍生 bids: [[0.50, 100], [0.45, 200]]  ← 来自 Yes asks 的互补

若 No 衍生 Bid[0] = 0.50, 但实际市场中有人挂 Sell No = 0.48:
  → 买入 No @ 0.48, 卖出 Yes @ 0.50（等价于 buy No @ 0.50 的互补方）
  → 利润 = 0.02 × Q
```

此策略需要更细粒度的订单簿监控。

### 2.3 策略 C：CRYPTO_UP_DOWN 市场的隐含波动率套利

Predict.fun 支持 `CRYPTO_UP_DOWN` 类型市场（BTC/ETH 短时涨跌），其价格必然遵循无套利约束。

假设 BTC 5min 涨跌市场：
- Yes 的 Fair Price 应由 Black-Scholes 或二叉树模型给出
- 若订单簿价格偏离理论价格超过阈值 → 套利

这需要实时价格馈送（通过 Pyth/Binance oracle）。

### 2.4 套利策略优先级矩阵

| 策略 | 风险 | 执行频率 | 效率 | 资金需求 |
|------|------|----------|------|----------|
| Yes/No 互补性 | 极低 | 中 | 高 | 中 |
| 订单簿流动性 | 低 | 高 | 中 | 中 |
| 隐含波动率 | 中 | 中 | 中高 | 高 |

---

## 3. 系统架构设计

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    监控层 (Monitor)                       │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐               │
│  │ WebSocket│ │ REST Poll│ │ Event Log │               │
│  │ Stream   │ │ Scanner  │ │ Listener  │               │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘               │
│       └────────────┬─────────────┘                      │
│                    ▼                                     │
│           ┌────────────────┐                            │
│           │  机会检测引擎   │                            │
│           │  (Arb Detector)│                            │
│           └───────┬────────┘                            │
└───────────────────┼──────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────────────┐
│                    决策层 (Decision)                      │
│  ┌───────────────────────────────────────┐              │
│  │  风险评估 & 利润计算                    │              │
│  │  - 滑点模拟                            │              │
│  │  - 费用核算                            │              │
│  │  - 资金充足性检查                       │              │
│  └───────────────────┬───────────────────┘              │
└──────────────────────┼──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    执行层 (Executor)                      │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ OrderBuilder│  │ JWT Auth     │  │ Transaction  │   │
│  │ (SDK)       │  │ Manager      │  │ Monitor       │   │
│  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘   │
│         └────────────────┬─────────────────┘            │
│                          ▼                              │
│              ┌────────────────────┐                     │
│              │  订单状态追踪引擎   │                     │
│              │  (Order Tracker)   │                     │
│              └────────────────────┘                     │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Predict.fun API                        │
│  ┌────────────────┐  ┌─────────────┐  ┌──────────────┐ │
│  │ REST API       │  │ WebSocket   │  │ BNB Chain    │ │
│  │ api.predict.fun│  │ ws-stream   │  │ CTFExchange  │ │
│  └────────────────┘  └─────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 职责 | 技术选型 |
|------|------|----------|
| **WebSocket Stream** | 实时接收订单簿增量更新 | `ws` 库订阅 Predict.fun WS |
| **REST Poll Scanner** | 定时轮询所有活跃市场的订单簿快照 | 240 req/min 限速内，轮询 60 market/cycle |
| **机会检测引擎** | 计算 Sum_Bid/Sum_Ask，识别套利机会 | 纯计算模块，无状态 |
| **风险评估** | 计算净利润、滑点、资金检查 | 调用 API 获取余额/持仓 |
| **OrderBuilder** | 构建并签署 EIP-712 订单 | `@predictdotfun/sdk` |
| **JWT Manager** | 管理 JWT Token 生命周期 | API Key → sign → JWT |
| **Order Tracker** | 追踪订单状态、部分成交、失败重试 | 轮询 `GET /v1/orders/{hash}` |
| **执行日志** | 记录所有交易用于审计和分析 | PostgreSQL / SQLite |
| **健康检查/告警** | 监控系统状态，异常告警 | Telegram/Discord webhook |

### 3.3 数据流

```
1. WS/REST 获取订单簿
       ↓
2. Arb Detector 计算价差
       ↓
3. 若发现机会 → Risk Engine 评估
       ↓
4. 通过 → OrderBuilder 构建订单
       ↓
5. JWT Auth → POST /v1/orders
       ↓
6. Order Tracker 监控成交
       ↓
7. 更新持仓记录
       ↓
8. 获取结算状态 → 赎回
```

---

## 4. 代码实现

### 4.1 项目结构

```
predict-arb/
├── src/
│   ├── config.ts           # 配置管理
│   ├── auth/
│   │   └── jwtManager.ts   # JWT 认证管理
│   ├── monitor/
│   │   ├── wsStream.ts     # WebSocket 实时流
│   │   └── restScanner.ts  # REST 轮询扫描器
│   ├── arb/
│   │   ├── detector.ts     # 套利机会检测
│   │   ├── riskEngine.ts   # 风险评估
│   │   └── types.ts        # 类型定义
│   ├── executor/
│   │   ├── orderBuilder.ts # 订单构建与签署
│   │   └── tradeExecutor.ts# 交易执行与追踪
│   ├── tracker/
│   │   └── orderTracker.ts # 订单状态追踪
│   ├── monitor/
│   │   └── healthCheck.ts  # 健康检查与告警
│   └── index.ts            # 入口文件
├── .env                    # 环境变量
├── package.json
└── tsconfig.json
```

### 4.2 核心类型定义 (`src/arb/types.ts`)

```typescript
export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface OrderbookData {
  marketId: number;
  updateTimestampMs: number;
  asks: OrderbookLevel[];
  bids: OrderbookLevel[];
}

export interface ArbitrageOpportunity {
  marketId: number;
  type: 'SELL_BOTH' | 'BUY_BOTH';
  timestamp: number;
  // Yes 侧数据
  yesBid: number;
  yesAsk: number;
  // No 侧数据（互补计算）
  noBid: number;
  noAsk: number;
  // 套利参数
  sumBid: number;
  sumAsk: number;
  profitBps: number;       // 利润（基点）
  quantity: number;        // 可执行数量
  estimatedProfitUSDT: number;
  estimatedFeesUSDT: number;
  estimatedGasUSDT: number;
  netProfitUSDT: number;
}

export interface MarketInfo {
  id: number;
  slug: string;
  title: string;
  decimalPrecision: number;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  feeRateBps: number;
  outcomes: {
    name: string;
    onChainId: string;
    indexSet: number;
  }[];
}

export interface ExecutionResult {
  success: boolean;
  opportunity: ArbitrageOpportunity;
  orders: {
    side: 'BUY' | 'SELL';
    outcome: 'YES' | 'NO';
    orderHash: string;
    orderId: string;
    status: 'FILLED' | 'PARTIAL' | 'PENDING' | 'FAILED';
    filledQuantity: number;
    filledPrice: number;
  }[];
  netProfitUSDT: number;
  executionTimeMs: number;
}
```

### 4.3 配置管理 (`src/config.ts`)

```typescript
import { config } from 'dotenv';
config();

export const AppConfig = {
  // API 配置
  apiBaseUrl: process.env.PREDICT_API_URL || 'https://api.predict.fun',
  wsUrl: process.env.PREDICT_WS_URL || 'wss://api.predict.fun/ws',
  apiKey: process.env.PREDICT_API_KEY || '',

  // 钱包配置
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
  predictAccountAddress: process.env.PREDICT_ACCOUNT_ADDRESS || '',

  // 套利参数
  minProfitBps: parseInt(process.env.MIN_PROFIT_BPS || '50', 10),
  maxPositionPerMarket: parseInt(process.env.MAX_POSITION_PER_MARKET || '10000', 10),
  maxTotalExposure: parseInt(process.env.MAX_TOTAL_EXPOSURE || '50000', 10),
  orderTimeoutMs: parseInt(process.env.ORDER_TIMEOUT_MS || '30000', 10),
  maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '30', 10),

  // 扫描参数
  restScanIntervalMs: parseInt(process.env.REST_SCAN_INTERVAL_MS || '5000', 10),
  wsReconnectDelayMs: parseInt(process.env.WS_RECONNECT_DELAY_MS || '3000', 10),

  // Gas 估算
  estimatedGasBnb: parseFloat(process.env.ESTIMATED_GAS_BNB || '0.0008'),
  bnbPriceUSDT: parseFloat(process.env.BNB_PRICE_USDT || '600'),

  // 通道
  chainId: 56, // BNB Mainnet
  decimalPrecisionDefault: 2,
} as const;
```

### 4.4 JWT 认证管理 (`src/auth/jwtManager.ts`)

```typescript
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
    });
  }

  async getToken(): Promise<string> {
    if (this.state && Date.now() < this.state.expiresAt - 60000) {
      return this.state.token;
    }
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string> {
    // Step 1: 获取签名消息
    const { data: msgResp } = await this.http.get('/v1/auth/message');
    const message = msgResp.data.message;

    // Step 2: 用钱包签署消息
    const signature = await this.wallet.signMessage(message);

    // Step 3: 获取 JWT
    const { data: jwtResp } = await this.http.post('/v1/auth/token', {
      message,
      signature,
      address: this.wallet.address,
    });

    this.state = {
      token: jwtResp.data.token,
      expiresAt: Date.now() + 55 * 60 * 1000, // 55 分钟，提前 5 分钟刷新
    };

    return this.state.token;
  }
}
```

### 4.5 套利机会检测 (`src/arb/detector.ts`)

```typescript
import { OrderbookData, OrderbookLevel, ArbitrageOpportunity, MarketInfo } from './types';
import { AppConfig } from '../config';

export class ArbitrageDetector {
  /**
   * 计算互补价格（文档原始公式）
   */
  static getComplement(price: number, decimalPrecision: number = 2): number {
    const factor = 10 ** decimalPrecision;
    return (factor - Math.round(price * factor)) / factor;
  }

  /**
   * 从 Yes 侧订单簿推导 No 侧订单簿
   */
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

  /**
   * 检测 Yes/No 互补性套利机会
   */
  detectComplementArbitrage(
    book: OrderbookData,
    marketInfo: MarketInfo,
    decimalPrecision: number = AppConfig.decimalPrecisionDefault
  ): ArbitrageOpportunity | null {
    if (book.asks.length === 0 || book.bids.length === 0) return null;

    const yesBestBid = book.bids[0][0];
    const yesBestAsk = book.asks[0][0];
    const noBestBid = this.getComplement(book.asks[0][0], decimalPrecision);
    const noBestAsk = this.getComplement(book.bids[0][0], decimalPrecision);

    const sumBid = yesBestBid + noBestBid;
    const sumAsk = yesBestAsk + noBestAsk;

    // 卖出套利：Sum_Bid > 1.00
    const sellProfitBps = Math.round((sumBid - 1) * 10000);
    if (sellProfitBps >= AppConfig.minProfitBps) {
      const quantity = Math.min(
        book.bids[0][1],   // Yes 最高买盘数量
        book.asks[0][1]     // Yes 最低卖盘数量（→ No 买盘）
      );
      const sellQuantity = Math.min(quantity, AppConfig.maxPositionPerMarket);
      const estimatedProfit = (sumBid - 1) * sellQuantity;

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
        estimatedProfitUSDT: estimatedProfit,
        estimatedFeesUSDT: 0, // 需从 API 获取
        estimatedGasUSDT: AppConfig.estimatedGasBnb * AppConfig.bnbPriceUSDT,
        netProfitUSDT: 0, // 由 riskEngine 计算
      };
    }

    // 买入套利：Sum_Ask < 1.00
    const buyProfitBps = Math.round((1 - sumAsk) * 10000);
    if (buyProfitBps >= AppConfig.minProfitBps) {
      const quantity = Math.min(
        book.asks[0][1],   // Yes 最低卖盘数量
        book.bids[0][1]     // Yes 最高买盘数量（→ No 卖盘）
      );
      const buyQuantity = Math.min(quantity, AppConfig.maxPositionPerMarket);
      const estimatedProfit = (1 - sumAsk) * buyQuantity;

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
        estimatedProfitUSDT: estimatedProfit,
        estimatedFeesUSDT: 0,
        estimatedGasUSDT: AppConfig.estimatedGasBnb * AppConfig.bnbPriceUSDT,
        netProfitUSDT: 0,
      };
    }

    return null;
  }

  /**
   * 扫描多个市场的订单簿
   */
  async scanMarket(
    book: OrderbookData,
    marketInfo: MarketInfo
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    const opp = this.detectComplementArbitrage(book, marketInfo);
    if (opp) {
      opportunities.push(opp);
    }

    return opportunities;
  }
}
```

### 4.6 风险评估引擎 (`src/arb/riskEngine.ts`)

> ⚠️ 当前实现缺少账户余额检查和抵押品充足性校验，详见 [第 7.3 节 BUG-03](#73-high-缺少账户余额检查)。

```typescript
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
    // 1. 检查当前仓位
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

    // 2. 计算滑点调整后的利润
    const slippageDiscount = (AppConfig.maxSlippageBps / 10000) * opp.quantity;
    const estimatedProfit = opp.estimatedProfitUSDT;

    // 3. 计算费用（BNB Gas 折合 USDT）
    const gasCostUSDT = opp.estimatedGasUSDT;

    // 4. 净利润
    const netProfit = estimatedProfit - slippageDiscount - gasCostUSDT;

    if (netProfit <= 0) {
      return {
        approved: false,
        adjustedQuantity: 0,
        netProfitUSDT: 0,
        reason: `净利润为负: ${netProfit.toFixed(4)} USDT`,
      };
    }

    return {
      approved: true,
      adjustedQuantity: opp.quantity,
      netProfitUSDT: netProfit,
    };
  }

  private async getCurrentPositions(): Promise<{
    marketId: number;
    size: number;
  }[]> {
    const token = await this.jwtManager.getToken();
    const { data } = await axios.get(`${AppConfig.apiBaseUrl}/v1/positions`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!data.success || !data.data) return [];

    return data.data.map((p: any) => ({
      marketId: p.marketId,
      size: parseFloat(p.size),
    }));
  }
}
```

### 4.7 交易执行器 (`src/executor/tradeExecutor.ts`)

> ⚠️ **注意：** 以下为修正后的版本。原始实现存在根本性 Bug（详见 [第 7 章 BUG-01](#71-critical-tradeexecutorts-执行逻辑错误)），No 腿使用了错误的 tokenId、价格和方向，导致套利必然亏损。

```typescript
import { OrderBuilder, Side, ChainId } from '@predictdotfun/sdk';
import { Wallet, parseEther } from 'ethers';
import axios from 'axios';
import { AppConfig } from '../config';
import { JWTManager } from '../auth/jwtManager';
import { ArbitrageOpportunity, ExecutionResult, OrderResult } from '../arb/types';
import { OrderTracker } from '../tracker/orderTracker';

export class TradeExecutor {
  private orderBuilder: OrderBuilder | null = null;
  private jwtManager: JWTManager;
  private signer: Wallet;
  private tracker: OrderTracker;
  private nonceCounter = 0n; // ✅ 递增 nonce

  constructor(jwtManager: JWTManager, tracker: OrderTracker) {
    this.jwtManager = jwtManager;
    this.tracker = tracker;
    this.signer = new Wallet(AppConfig.walletPrivateKey);
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
    if (marketInfo.outcomes.length < 2) throw new Error('Need 2 outcomes');

    const token = await this.jwtManager.getToken();
    const results: OrderResult[] = [];
    const startTime = Date.now();
    const feeRate = marketInfo.feeRateBps || 0;
    const yesTokenId = marketInfo.outcomes[0].onChainId;
    const noTokenId = marketInfo.outcomes[1].onChainId;  // ✅ 使用 No tokenId

    try {
      if (opp.type === 'SELL_BOTH') {
        // ✅ 腿1: SELL Yes Token @ bestBid
        const yesResult = await this.submitLimitOrder(
          Side.SELL, yesTokenId, opp.yesBid, opp.quantity,
          marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'YES'
        );
        results.push(yesResult);

        // ✅ 腿2: SELL No Token @ noBid（价格用 No 侧原价，不做 1-p 转换）
        const noResult = await this.submitLimitOrder(
          Side.SELL, noTokenId, opp.noBid, opp.quantity,
          marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'NO'
        );
        results.push(noResult);
      } else {
        // ✅ BUY_BOTH: 两腿均为 BUY
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

      // ✅ 并行等待成交
      const filledResults = await Promise.allSettled(
        results.map(r => this.tracker.waitForFill(r.orderHash, AppConfig.orderTimeoutMs))
      );

      const finalResults: OrderResult[] = [];
      let allFilled = true;

      for (let i = 0; i < filledResults.length; i++) {
        const fr = filledResults[i];
        if (fr.status === 'fulfilled') {
          finalResults.push({
            ...results[i],
            status: 'FILLED',
            filledQuantity: fr.value.filledQuantity,
            filledPrice: fr.value.filledPrice,
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
        // ⚠️ TODO: 对已成交的腿执行紧急对冲
      }

      return {
        success: allFilled,
        opportunity: opp,
        orders: finalResults,
        netProfitUSDT: allFilled ? opp.netProfitUSDT : 0,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        opportunity: opp,
        orders: results,
        netProfitUSDT: 0,
        executionTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
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
      nonce: this.getNextNonce(),  // ✅ 递增 nonce
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
```

### 4.8 订单追踪器 (`src/tracker/orderTracker.ts`)

```typescript
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
  private pendingOrders: Map<string, OrderStatus> = new Map();

  constructor(jwtManager: JWTManager) {
    this.jwtManager = jwtManager;
  }

  trackOrder(hash: string): void {
    this.pendingOrders.set(hash, {
      hash,
      status: 'PENDING',
      filledQuantity: 0,
      filledPrice: 0,
    });
  }

  async waitForFill(hash: string, timeoutMs: number = 30000): Promise<OrderStatus> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const token = await this.jwtManager.getToken();

      try {
        const { data } = await axios.get(
          `${AppConfig.apiBaseUrl}/v1/orders/${hash}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (data.success && data.data) {
          const order = data.data;
          const status: OrderStatus = {
            hash,
            status: order.status,
            filledQuantity: parseFloat(order.filledQuantity || '0'),
            filledPrice: parseFloat(order.avgPrice || '0'),
          };

          this.pendingOrders.set(hash, status);

          if (status.status === 'FILLED') {
            return status;
          }
          if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
            throw new Error(`订单 ${hash} 状态: ${status.status}`);
          }
        }
      } catch (error) {
        console.error(`查询订单 ${hash} 失败:`, error);
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`订单 ${hash} 超时未成交`);
  }

  async cancelOrder(hash: string): Promise<void> {
    const token = await this.jwtManager.getToken();
    await axios.delete(`${AppConfig.apiBaseUrl}/v1/orders`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { data: { hashes: [hash] } },
    });
    this.pendingOrders.delete(hash);
  }
}
```

### 4.9 WebSocket 实时流 (`src/monitor/wsStream.ts`)

```typescript
import WebSocket from 'ws';
import { AppConfig } from '../config';
import { OrderbookData } from '../arb/types';

type OrderbookCallback = (book: OrderbookData) => void;

export class WebSocketStream {
  private ws: WebSocket | null = null;
  private callbacks: Map<string, Set<OrderbookCallback>> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  start(): void {
    this.isRunning = true;
    this.connect();
  }

  stop(): void {
    this.isRunning = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  subscribe(marketId: number, callback: OrderbookCallback): void {
    const key = marketId.toString();
    if (!this.callbacks.has(key)) {
      this.callbacks.set(key, new Set());
    }
    this.callbacks.get(key)!.add(callback);

    // 若已连接，发送订阅
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'market',
        marketId,
      }));
    }
  }

  unsubscribe(marketId: number, callback: OrderbookCallback): void {
    const key = marketId.toString();
    const cbs = this.callbacks.get(key);
    if (cbs) cbs.delete(callback);
  }

  private connect(): void {
    this.ws = new WebSocket(AppConfig.wsUrl);

    this.ws.on('open', () => {
      console.log('WebSocket 已连接');
      // 重新订阅所有市场
      for (const marketId of this.callbacks.keys()) {
        this.ws!.send(JSON.stringify({
          type: 'subscribe',
          channel: 'market',
          marketId: parseInt(marketId),
        }));
      }
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'orderbook' && msg.data) {
          const book: OrderbookData = msg.data;
          const cbs = this.callbacks.get(book.marketId.toString());
          if (cbs) {
            for (const cb of cbs) cb(book);
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    });

    this.ws.on('close', () => {
      console.log('WebSocket 已断开');
      if (this.isRunning) {
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          AppConfig.wsReconnectDelayMs
        );
      }
    });

    this.ws.on('error', (err) => {
      console.error('WebSocket 错误:', err.message);
    });
  }
}
```

### 4.10 主入口 (`src/index.ts`)

> ⚠️ 当前实现使用 cron-based REST 轮询（默认每 5 分钟），WebSocket 实时流尚未集成。详见 [第 7.7 节](#77-medium-rest-轮询频率与时效性) 的改进建议。

```typescript
import cron from 'node-cron';
import axios from 'axios';
import { JWTManager } from './auth/jwtManager';
import { ArbitrageDetector } from './arb/detector';
import { RiskEngine } from './arb/riskEngine';
import { TradeExecutor } from './executor/tradeExecutor';
import { OrderTracker } from './tracker/orderTracker';
import { WebSocketStream } from './monitor/wsStream';
import { AppConfig } from './config';
import axios from 'axios';

class ArbitrageService {
  private jwtManager: JWTManager;
  private detector: ArbitrageDetector;
  private riskEngine: RiskEngine;
  private executor: TradeExecutor;
  private tracker: OrderTracker;
  private wsStream: WebSocketStream;
  private activeMarkets: Map<number, any> = new Map();
  private isProcessing: Set<number> = new Set(); // 防止重复处理

  constructor() {
    this.jwtManager = new JWTManager();
    this.detector = new ArbitrageDetector();
    this.riskEngine = new RiskEngine(this.jwtManager);
    this.executor = new TradeExecutor(this.jwtManager);
    this.tracker = new OrderTracker(this.jwtManager);
    this.wsStream = new WebSocketStream();
  }

  async start(): Promise<void> {
    console.log('启动 Predict.fun 套利服务...');

    // 初始化执行器
    await this.executor.initialize();

    // 获取所有活跃市场
    await this.loadActiveMarkets();

    // 启动 WebSocket 监控
    this.wsStream.start();

    for (const [marketId, marketInfo] of this.activeMarkets) {
      this.wsStream.subscribe(marketId, (book) => {
        this.handleOrderbookUpdate(book, marketInfo);
      });
    }

    // 启动定时全量扫描（兜底）
    setInterval(() => this.fullScan(), AppConfig.restScanIntervalMs);

    console.log(`监控 ${this.activeMarkets.size} 个活跃市场`);
  }

  private async loadActiveMarkets(): Promise<void> {
    const token = await this.jwtManager.getToken();
    const { data } = await axios.get(`${AppConfig.apiBaseUrl}/v1/markets`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { status: 'ACTIVE', limit: 100 },
    });

    if (data.success && data.data) {
      for (const market of data.data) {
        this.activeMarkets.set(market.id, market);
      }
    }
  }

  private async handleOrderbookUpdate(
    book: any,
    marketInfo: any
  ): Promise<void> {
    const marketId = book.marketId;

    // 防止同一个市场被重复处理
    if (this.isProcessing.has(marketId)) return;
    this.isProcessing.add(marketId);

    try {
      const opportunities = this.detector.scanMarket(book, marketInfo);
      for (const opp of opportunities) {
        // 风险评估
        const evaluation = await this.riskEngine.evaluate(opp);
        if (!evaluation.approved) {
          console.log(`市场 ${opp.marketId} 未通过风险评估: ${evaluation.reason}`);
          continue;
        }

        // 执行
        console.log(
          `发现套利机会: 市场=${opp.marketId}, 类型=${opp.type}, ` +
          `预估利润=${opp.estimatedProfitUSDT.toFixed(4)} USDT`
        );

        const result = await this.executor.executeOpportunity(opp, marketInfo);
        console.log(`执行结果: success=${result.success}, netProfit=${result.netProfitUSDT.toFixed(4)}`);

        // 追踪订单
        if (!result.success) {
          for (const order of result.orders) {
            try {
              await this.tracker.cancelOrder(order.orderHash);
            } catch (e) {
              // 忽略取消失败
            }
          }
        }
      }
    } finally {
      this.isProcessing.delete(marketId);
    }
  }

  private async fullScan(): Promise<void> {
    const token = await this.jwtManager.getToken();

    for (const [marketId, marketInfo] of this.activeMarkets) {
      try {
        const { data } = await axios.get(
          `${AppConfig.apiBaseUrl}/v1/markets/${marketId}/orderbook`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (data.success && data.data) {
          await this.handleOrderbookUpdate(data.data, marketInfo);
        }
      } catch (e) {
        // 跳过失败的市场
      }
    }
  }
}

// 启动
const service = new ArbitrageService();
service.start().catch(console.error);
```

### 4.11 环境变量模板 (`.env.example`)

```env
# Predict.fun API
PREDICT_API_URL=https://api.predict.fun
PREDICT_API_KEY=your_api_key_here

# 钱包
WALLET_PRIVATE_KEY=your_private_key_here

# 套利参数
MIN_PROFIT_BPS=150                  # ⚠️ 上调至 150，50 bps 无法覆盖实际成本
MAX_POSITION_PER_MARKET=10000
MAX_TOTAL_EXPOSURE=50000
ORDER_TIMEOUT_MS=15000              # 建议降低至 15s，减少窗口期暴露
MAX_SLIPPAGE_BPS=30

# 扫描参数
ARB_SCAN_CRON=*/1 * * * *          # 建议提升至每 1 分钟（原 5 分钟太慢）
# 或使用更激进的值（注意 API 限流：240 req/min）
# ARB_SCAN_CRON=*/15 * * * * *      # 每 15 秒（需要确保市场数 × 2 < 240/min）

# Gas 估算（建议后续接入实时 Gas Oracle）
ESTIMATED_GAS_BNB=0.0008
BNB_PRICE_USDT=600
```

---

## 5. 风险控制与监控

### 5.1 风险矩阵

| 风险类别 | 描述 | 缓解措施 |
|----------|------|----------|
| **部分成交风险** | 两笔订单只有一笔成交，持仓不平衡 | 超时自动取消未成交订单并平掉已成交仓位 |
| **滑点风险** | 提交订单时订单簿已变化 | 设定 `maxSlippageBps` 限制；优先使用 LIMIT 而非 MARKET |
| **预言机风险** | UMA 解析结果与预期不同 | 仅交易明确的市场规则 |
| **资金风险** | 市场长期不结算，资金被锁 | 设定单市场最大敞口和总敞口上限 |
| **Gas 飙升** | BNB Gas 突然升高导致利润为负 | 动态 Gas 估算，利润阈值包含 Gas 缓冲 |
| **API 限流** | 超过 240 req/min 被限流 | 请求队列 + 指数退避重试 |
| **JWT 过期** | Token 过期导致订单失败 | 提前 5 分钟刷新 Token |

### 5.2 监控指标

```typescript
export interface HealthMetrics {
  uptime: number;
  marketsWatched: number;
  opportunitiesDetected: number;
  tradesExecuted: number;
  successRate: number;
  totalProfitUSDT: number;
  avgProfitPerTrade: number;
  lastTradeAt: number | null;
}

class HealthMonitor {
  private stats = {
    opportunitiesDetected: 0,
    tradesExecuted: 0,
    successfulTrades: 0,
    totalProfitUSDT: 0,
  };

  recordDetection(): void { this.stats.opportunitiesDetected++; }
  recordTrade(success: boolean, profit: number): void {
    this.stats.tradesExecuted++;
    if (success) {
      this.stats.successfulTrades++;
      this.stats.totalProfitUSDT += profit;
    }
  }

  getMetrics(): HealthMetrics {
    return {
      uptime: process.uptime(),
      marketsWatched: 0, // 注入
      opportunitiesDetected: this.stats.opportunitiesDetected,
      tradesExecuted: this.stats.tradesExecuted,
      successRate: this.stats.tradesExecuted > 0
        ? this.stats.successfulTrades / this.stats.tradesExecuted
        : 1,
      totalProfitUSDT: this.stats.totalProfitUSDT,
      avgProfitPerTrade: this.stats.tradesExecuted > 0
        ? this.stats.totalProfitUSDT / this.stats.tradesExecuted
        : 0,
      lastTradeAt: null,
    };
  }
}
```

---

## 6. 部署与运维

### 6.1 部署步骤

```bash
# 1. 安装依赖
npm install @predictdotfun/sdk ethers ws axios dotenv

# 2. 编译
npm run build

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key 和私钥

# 4. 先运行测试网
PREDICT_API_URL=https://api-testnet.predict.fun \
PREDICT_WS_URL=wss://api-testnet.predict.fun/ws \
npm start

# 5. 验证正确后切换主网
npm start
```

### 6.2 Docker 部署

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
CMD ["node", "dist/index.js"]
```

### 6.3 生产建议

1. **使用 PM2 或 Docker Compose 进行进程管理**，确保崩溃后自动重启
2. **日志收集**：将执行日志写入结构化 JSON，接入 ELK/Grafana
3. **告警系统**：Telegram/Discord Bot 实时推送异常
4. **资金隔离**：套利资金与日常资金分地址管理
5. **API Key 轮换**：定期生成新的 API Key
6. **监控面板**：Grafana Dashboard 显示利润曲线、检测次数、成功率

---

## 7. 已知问题、现存 Bug 与修正方案（⭐ 新增）

### 7.1 CRITICAL: tradeExecutor.ts 执行逻辑错误

**当前代码**（[tradeExecutor.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Multiarbooor/src/executor/tradeExecutor.ts#L49-L77)）存在根本性的执行逻辑错误：

```typescript
// ❌ 当前错误实现
if (opp.type === 'SELL_BOTH') {
  // 腿1: SELL Yes @ yesBid  ← 正确
  const yesResult = await this.submitLimitOrder(Side.SELL, yesTokenId, opp.yesBid, ...);
  
  // 腿2: BUY Yes @ (1-noBid) = yesAsk  ← 错误！
  const noComplementPrice = parseFloat((1 - opp.noBid).toFixed(4));
  const noResult = await this.submitLimitOrder(Side.BUY, yesTokenId, noComplementPrice, ...);
} else {
  // BUY_BOTH:
  // 腿1: BUY Yes @ yesAsk  ← 正确
  const yesResult = await this.submitLimitOrder(Side.BUY, yesTokenId, opp.yesAsk, ...);
  
  // 腿2: SELL Yes @ (1-noAsk) = yesBid  ← 错误！
  const noComplementPrice = parseFloat((1 - opp.noAsk).toFixed(4));
  const noResult = await this.submitLimitOrder(Side.SELL, yesTokenId, noComplementPrice, ...);
}
```

**问题分析：**

对于 SELL_BOTH，当前代码执行：
- 腿1: SELL Yes @ yesBid → 收到 yesBid，欠 1 Yes
- 腿2: BUY Yes @ yesAsk → 支付 yesAsk，获得 1 Yes
- 净现金流 = yesBid - yesAsk，由于 bid < ask 恒成立，净现金流 < 0（**必然亏损！**）

对于 BUY_BOTH，同理：
- 腿1: BUY Yes @ yesAsk → 支付 yesAsk
- 腿2: SELL Yes @ yesBid → 收到 yesBid
- 净现金流 = yesBid - yesAsk < 0（**必然亏损！**）

**根源：** 代码混淆了 "推导 No 侧价格" 和 "用 Yes Token 合成 No 仓位" 两个概念。在统一订单簿中，所有订单在提交时就已归一化到 Yes 定价，不需要在客户端做手动合成。

**修正后代码：**

```typescript
async executeOpportunity(
  opp: ArbitrageOpportunity,
  marketInfo: { isNegRisk: boolean; isYieldBearing: boolean; feeRateBps: number;
                outcomes: { name: string; onChainId: string; indexSet: number }[] }
): Promise<ExecutionResult> {
  if (!this.orderBuilder) throw new Error('OrderBuilder not initialized');
  if (marketInfo.outcomes.length < 2) throw new Error('Market requires 2 outcomes');

  const token = await this.jwtManager.getToken();
  const results: OrderResult[] = [];
  const startTime = Date.now();
  const feeRate = marketInfo.feeRateBps || 0;

  const yesTokenId = marketInfo.outcomes[0].onChainId;
  const noTokenId  = marketInfo.outcomes[1].onChainId;

  try {
    if (opp.type === 'SELL_BOTH') {
      // ✅ 腿1: SELL Yes Token @ bestBidYes
      const yesResult = await this.submitLimitOrder(
        Side.SELL, yesTokenId, opp.yesBid, opp.quantity,
        marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'YES'
      );
      results.push(yesResult);

      // ✅ 腿2: SELL No Token @ bestNoBid（引擎自动转化为 BUY Yes 并匹配）
      const noResult = await this.submitLimitOrder(
        Side.SELL, noTokenId, opp.noBid, opp.quantity,
        marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'NO'
      );
      results.push(noResult);
    } else {
      // ✅ BUY_BOTH
      // 腿1: BUY Yes Token @ bestAskYes
      const yesResult = await this.submitLimitOrder(
        Side.BUY, yesTokenId, opp.yesAsk, opp.quantity,
        marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'YES'
      );
      results.push(yesResult);

      // ✅ 腿2: BUY No Token @ bestNoAsk（引擎自动转化为 SELL Yes 并匹配）
      const noResult = await this.submitLimitOrder(
        Side.BUY, noTokenId, opp.noAsk, opp.quantity,
        marketInfo.isNegRisk, marketInfo.isYieldBearing, feeRate, token, 'NO'
      );
      results.push(noResult);
    }

    // ✅ 并行等待成交（而非串行 200ms 延迟）
    const filledResults = await Promise.allSettled(
      results.map(r => this.tracker.waitForFill(r.orderHash, AppConfig.orderTimeoutMs))
    );

    // 检查成交状态，取消未成交订单...
    // ...
  } catch (error) { ... }
}
```

**关键修正点：**
1. No 腿使用 `noTokenId`（`outcomes[1].onChainId`）而非 `yesTokenId`
2. No 腿的价格直接使用 `opp.noBid` / `opp.noAsk`（No 侧原价），不做 `1 - price` 转换
3. SELL_BOTH 两腿均为 SELL，BUY_BOTH 两腿均为 BUY（不再是交叉的 SELL+BUY）
4. 去掉第 55 行的 200ms `setTimeout` 延迟，改为并行 `Promise.allSettled` 等待成交

### 7.2 CRITICAL: Nonce 硬编码为 0n

**当前代码** ([tradeExecutor.ts:L157](file:///Users/lei/VibeCoding/TRAE-SOLO/Multiarbooor/src/executor/tradeExecutor.ts#L157))：

```typescript
const order = this.orderBuilder.buildOrder('LIMIT', {
  maker: this.signer.address,
  signer: this.signer.address,
  side,
  tokenId,
  makerAmount,
  takerAmount,
  nonce: 0n,  // ❌ 硬编码！每笔订单 nonce 相同
  feeRateBps: feeRateBps,
});
```

两笔套利订单使用相同的 nonce = 0n，可能导致：
- Predict.fun API 拒绝第二笔订单（因为 nonce 与第一笔冲突）
- 订单取消/替换逻辑异常

**修正方案：** 实现单调递增 nonce 计数器：

```typescript
private nonceCounter = 0n;

private getNextNonce(): bigint {
  this.nonceCounter += 1n;
  return this.nonceCounter;
}
```

或在 SDK 层通过 `GET /v1/orders` 获取当前最大 nonce 后递增。

### 7.3 HIGH: 缺少账户余额检查

RiskEngine 检查了持仓敞口，但**未检查账户 USDC/BNB 余额是否足以覆盖交易**：

- SELL_BOTH：Predict.fun 可能要求每腿预留等额抵押品（1×qty USDC），共需 2×qty 抵押
- BUY_BOTH：实际需要支付 (bestAsk + bestNoAsk) × qty USDC

**修正方案：** 在 RiskEngine 中新增余额检查：

```typescript
private async checkBalance(opp: ArbitrageOpportunity): Promise<boolean> {
  // 调用 GET /v1/positions 或 /v1/accounts 获取可用余额
  const balance = await this.getAccountBalance();
  
  if (opp.type === 'BUY_BOTH') {
    const totalCost = (opp.yesAsk + opp.noAsk) * opp.quantity;
    return balance.usdcAvailable >= totalCost;
  } else {
    // SELL_BOTH：检查抵押品需求（取决于平台规则）
    const collateralRequired = opp.quantity * 2; // 保守估计
    return balance.usdcAvailable >= collateralRequired;
  }
}
```

### 7.4 HIGH: 缺少 Token 赎回逻辑

方案设计提到"到期后赎回 WIN token = 1 USDT × Q"，但代码中完全缺失赎回实现。

**需要实现：**
1. 监控市场状态 → 检测 `status` 变为 `RESOLVED`
2. 判断哪个 outcome 获胜（通过 `GET /v1/markets/{id}` 的 `resolution` 字段）
3. 调用 CTF 合约 `redeemPositions` 或通过 Predict.fun API 执行赎回
4. 赎回 Gas 成本需计入总利润核算

### 7.5 MEDIUM: 缺少结算状态监控和市场生命周期管理

当前代码未处理以下市场状态：
- **REGISTERED / PRICE_PROPOSED** → 可交易，正常扫描
- **ACTIVE** → 可交易
- **RESOLVING** → 等待结算，不可交易
- **RESOLVED** → 已结算，需要赎回

**修正方案：** 在扫描前过滤市场状态，跳过已结算的市场；对 RESOLVED 市场触发赎回。

### 7.6 MEDIUM: 静态 Gas 估算

当前使用固定值 `ESTIMATED_GAS_BNB=0.0008`，BNB 价格 `BNB_PRICE_USDT=600`。实际 Gas 价格在 BNB Chain 上波动较大（0.5-5 Gwei）。

**修正方案：** 对接 BNB Chain RPC 获取实时 Gas 价格：

```typescript
async function getLiveGasCostUSDT(provider: ethers.JsonRpcProvider): Promise<number> {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice!; // wei
  const estimatedGas = 300000n; // 单笔订单预估 Gas
  const txnCostWei = gasPrice * estimatedGas;
  const bnbPrice = await getBNBPrice(); // 从 DEX/预言机获取
  return parseFloat(ethers.formatEther(txnCostWei)) * bnbPrice;
}
```

### 7.7 MEDIUM: REST 轮询频率与时效性

当前采用 cron-based REST 轮询（每 5 分钟），对于毫秒级别的套利机会显然太慢。虽然当前未使用 WebSocket，但：

**短期改进：** 将扫描间隔缩短至 10-15 秒，并对高频市场做优先扫描排序
**长期改进：** 接入 Predict.fun WebSocket stream (`wss://api.predict.fun/ws`) 实时接收订单簿更新

### 7.8 MEDIUM: 单线程执行瓶颈

当前 `ArbitrageService` 遍历市场逐个获取订单簿并处理，N 个市场需要 N 次串行 API 调用。

**修正方案：** 使用并发请求 + 限流控制：

```typescript
async function batchScan(marketIds: number[], concurrency: number = 10): Promise<void> {
  const chunks = chunk(marketIds, concurrency);
  for (const batch of chunks) {
    await Promise.all(batch.map(id => scanOne(id)));
  }
}
```

### 7.9 LOW: 部分成交应急处理未被验证

当一腿成交、另一腿未成交时，当前代码取消未成交订单。但**已成交的那一腿产生了单向风险敞口**。代码未实现：
- 紧急对冲挂单（用市价单平掉已成交仓位）
- 等待再次尝试完成第二腿

### 7.10 完整 Bug 清单与优先级

| ID | 严重度 | 模块 | 问题 | 修正状态 |
|----|--------|------|------|----------|
| BUG-01 | 🔴 CRITICAL | tradeExecutor.ts:L49-L77 | SELL_BOTH/BUY_BOTH 执行逻辑错误：No 腿使用了错误的 tokenId、价格和方向 | ⚠️ 待修复 |
| BUG-02 | 🔴 CRITICAL | tradeExecutor.ts:L157 | nonce 硬编码为 0n，多订单冲突 | ⚠️ 待修复 |
| BUG-03 | 🟠 HIGH | riskEngine.ts | 缺少账户余额/抵押品检查 | ⚠️ 待实现 |
| BUG-04 | 🟠 HIGH | 全模块 | 缺少 Token 赎回逻辑（CTF redeemPositions） | ❌ 未实现 |
| BUG-05 | 🟠 HIGH | config.ts | 静态 Gas 估算，无实时 Gas oracle | ⚠️ 待完善 |
| BUG-06 | 🟡 MEDIUM | index.ts | 缺少市场结算状态监控和生命周期管理 | ❌ 未实现 |
| BUG-07 | 🟡 MEDIUM | index.ts | 单线程串行扫描，无并发优化 | ⚠️ 待优化 |
| BUG-08 | 🟡 MEDIUM | tradeExecutor.ts:L55,L69 | 200ms 串行延迟（setTimeout）而非并行提交 | ⚠️ 待修复 |
| BUG-09 | 🟡 MEDIUM | tradeExecutor.ts:L80-L102 | 部分成交后未对冲已成交单腿 | ⚠️ 待完善 |
| BUG-10 | 🟢 LOW | riskEngine.ts:L57 | 滑点计算使用简单线性估算而非实际订单簿模拟 | ⚠️ 待优化 |
| BUG-11 | 🟢 LOW | detector.ts:L6-L9 | getComplement 使用 Math.round 可能在边界产生 0.01 的舍入误差 | ⚠️ 待评估 |

---

## 8. 稳定性增强与扩展建议（⭐ 新增）

### 8.1 沙箱测试与分阶段上线

```
Phase 1: 模拟模式（Dry Run）
  - 仅检测套利机会，记录日志，不实际提交订单
  - 验证检测频率、机会数量、理论利润率
  - 运行周期：至少 1 周

Phase 2: 测试网小额实盘
  - 使用 api-testnet.predict.fun
  - 最小交易量（$10-$50），验证完整执行链路
  - 验证：订单提交、成交、取消、赎回全流程
  - 运行周期：至少 2 周，完成 ≥ 50 笔交易

Phase 3: 主网保守上线
  - 高阈值（MIN_PROFIT_BPS ≥ 200）
  - 低仓位（MAX_POSITION_PER_MARKET ≤ $500）
  - 手动审批模式（发现机会后暂停，人工确认后执行）
  - 运行周期：至少 1 个月

Phase 4: 全自动运行
  - 根据 Phase 3 数据调整参数
  - 逐步降低阈值，提高仓位
  - 7×24 自动运行
```

### 8.2 代码防御性加固建议

1. **幂等性保护：** 每笔套利交易关联唯一 `idempotencyKey`（基于 `marketId + timestamp + sumBid`），提交订单前检查是否已处理过
2. **并发锁：** 每个 marketId 的订单提交需要分布式锁（或内存 Mutex），防止同一机会被两次执行
3. **重试与降级：** API 调用失败时指数退避重试（最多 3 次），超过后记录告警并跳过
4. **资金安全：** 套利专用钱包与日常资金隔离，预留 BNB 余额阈值（至少 0.1 BNB 确保 Gas 充足）
5. **交易熔断：** 连续 N 次交易亏损，自动暂停并告警

### 8.3 增强监控指标

```typescript
interface EnhancedMetrics {
  // 基础指标
  opportunitiesDetected: number;
  tradesExecuted: number;
  successRate: number;
  totalRealizedPnl: number;

  // 新增指标
  marketCoverage: number;           // 实际扫描的市场数 / 活跃市场总数
  avgDetectionLatencyMs: number;    // 从订单簿更新到检测完成的平均延迟
  avgExecutionLatencyMs: number;    // 从提交到成交的平均延迟
  partialFillRate: number;          // 部分成交率
  cancellationRate: number;         // 订单取消率
  gasCostTotal: number;             // 累计 Gas 成本
  feeCostTotal: number;             // 累计平台手续费
  netPnlAfterAllCosts: number;      // 扣除所有成本后的净利润
  largestDrawdown: number;          // 最大回撤
  sharpeRatio: number;              // 夏普比率（日度）
}
```

---

## 9. 方案可行性总结（⭐ 新增）

### 9.1 理论可行性：✅ 成立（有条件）

- SELL_BOTH 套利：数学上成立，前提是统一订单簿中存在来源异构的挂单（直接 No 侧订单混合）
- BUY_BOTH 套利：同理
- **限制条件：** 若所有挂单均为同源（纯 Yes 直接订单），则 `bestBid < bestAsk` 恒成立，套利不可能。策略的实际可行性取决于 Predict.fun 平台上存在独立的 No 侧直接挂单的活跃度。

### 9.2 代码可行性：⚠️ 大量 Bug 需修复

- tradeExecutor.ts 核心执行逻辑存在方向性错误（BUG-01），必须修复
- Nonce 管理（BUG-02）、余额检查（BUG-03）、赎回逻辑（BUG-04）均缺失
- 建议完成所有优先级为 CRITICAL 和 HIGH 的 Bug 修复后再上线

### 9.3 经济可行性：⚠️ 阈值需校准

- 原 50 bps 阈值严重低估实际成本
- 考虑 Gas × 4-5 笔交易 + 平台费 + 滑点 + 利润要求，实际门槛约 150-200 bps
- 在低流动性市场可能更不利

### 9.4 竞争可行性：⚠️ 不确定性高

- 套利逻辑公开后，可能存在同类机器人竞争
- Predict.fun 平台相对小众，竞争程度低于 Polymarket
- 先发优势窗口期有限，需尽快完善代码并上线

### 9.5 建议优先级

| 优先级 | 事项 | 预期收益 |
|--------|------|----------|
| P0 | 修复 BUG-01（执行逻辑）和 BUG-02（nonce） | 使策略能从"必然亏损"变为"可能盈利" |
| P0 | 实现沙盒模拟模式（Dry Run） | 在不冒资金风险的情况下验证策略 |
| P1 | 实现余额检查（BUG-03）和赎回逻辑（BUG-04） | 保障资金安全，闭环交易流程 |
| P1 | 动态阈值 + 实时 Gas Oracle（BUG-05） | 避免在 Gas 飙升时执行亏损交易 |
| P2 | 并发扫描优化（BUG-07）和 WebSocket | 提高检测频率，不错过窗口期 |
| P2 | 测试网实盘验证（Phase 2） | 端到端验证全流程 |
| P3 | 部分成交应急对冲（BUG-09） | 减少意外亏损 |
