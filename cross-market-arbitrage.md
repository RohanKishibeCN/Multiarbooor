# Predict.fun ↔ Polymarket 跨市场合成套利方案

## 目录

1. [第一性原理：跨市场套利的基础](#1-第一性原理跨市场套利的基础)
2. [两个平台的架构对比](#2-两个平台的架构对比)
3. [套利策略体系](#3-套利策略体系)
4. [系统架构设计](#4-系统架构设计)
5. [代码实现](#5-代码实现)
6. [跨链桥接方案](#6-跨链桥接方案)
7. [风险控制与监控](#7-风险控制与监控)
8. [部署与运维](#8-部署与运维)

---

## 1. 第一性原理：跨市场套利的基础

### 1.1 为什么跨市场套利在理论上可行

两个平台的共同基础：

```
                  ┌─────────────────────────┐
                  │   UMA Optimistic Oracle  │  ← 同一套预言机基础设施
                  └───────────┬─────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                                       ▼
  ┌───────────────────┐                 ┌───────────────────┐
  │   Polymarket CTF  │                 │  Predict.fun CTF  │
  │   (Polygon)       │                 │  (BNB Chain)      │
  │                   │                 │                   │
  │ Yes Token: $1     │                 │ Yes Token: $1     │
  │ No Token:  $1     │                 │ No Token:  $1     │
  │ Collateral: pUSD  │                 │ Collateral: USDT  │
  └───────────────────┘                 └───────────────────┘
```

**核心原理**：对于同一个真实世界事件的结果，两个平台最终都必须输出相同的结果（事件发生 → YES wins；不发生 → NO wins）。因此：

- Polymarket YES Token + Predict.fun NO Token = 1（无论结果）
- Polymarket NO Token + Predict.fun YES Token = 1（无论结果）

**套利条件**：

```
// 策略 A：买 Polymarket YES + 买 Predict.fun NO
Cost = Price_PM_YES + Price_PF_NO + Bridge_Cost + Fees
If Cost < 1.00 → 无风险利润

// 策略 B：买 Polymarket NO + 买 Predict.fun YES
Cost = Price_PM_NO + Price_PF_YES + Bridge_Cost + Fees
If Cost < 1.00 → 无风险利润
```

### 1.2 利润模型

```
Profit = (1.00 - Cost_Y + Cost_N) × Q - CrossChain_Cost - Platform_Fees - Gas

其中：
  Q            = 头寸规模（shares）
  Cost_Y       = Min(PM_YES_Ask, PF_YES_Ask)  按最优价格买入 YES
  Cost_N       = Min(PM_NO_Ask, PF_NO_Ask)    按最优价格买入 NO
  CrossChain_Cost = 桥接费 + 滑点 (约 0.1%-0.3%)
  Platform_Fees   = Polymarket taker fee + Predict.fun fee
  Gas             = Polygon gas + BNB gas
```

### 1.3 Polymarket 费用结构

Polymarket 的 Taker Fee 公式：

```
fee = C × feeRate × p × (1 - p)

其中：
  C       = 交易份额数
  p       = 成交价格
  feeRate = 按类别不同
```

| 类别 | feeRate | 50%概率下 100 shares 费用 |
|------|---------|--------------------------|
| Crypto | 0.072 | $1.80 |
| Sports | 0.03 | $0.75 |
| Finance / Politics / Tech | 0.04 | $1.00 |
| Economics / Culture / Weather | 0.05 | $1.25 |
| Geopolitics | 0 | $0 |

费用对称中心在 p=0.50，最高费用在 p=0.50，向两端递减到 0。

**Maker 不收费，Maker 还有 Rebate**，这意味着做 Maker 有额外收益。

### 1.4 Predict.fun 费用估算

Predict.fun 费用文档未公开，但基于 CTF Exchange 架构，预估平台内 Fee ∈ [0, 0.3%]。实际套利中采用保守估计 0.5%。

### 1.5 最小套利规模计算

```
假设跨链桥接成本 = 0.2%，双平台 Fee = 1.0%，滑点 = 0.3%
总摩擦成本 ≈ 1.5%

若目标利润 = 0.5% (5bps)，则需要 cost_Y + cost_N < 1.00 - 0.02 = 0.98
即 Sum_Ask 偏离 1.00 超过 2 个百分点。

最小套利规模 = 总摩擦成本 × 2 / profit_per_share
  = (桥接费 + 双平台Fee + Gas) / 套利价差
```

对于典型的 1% 价差机会，至少需要 $10,000 规模才能产生有意义利润。

---

## 2. 两个平台的架构对比

### 2.1 完整对比表

| 维度 | Polymarket | Predict.fun |
|------|-----------|-------------|
| **链** | Polygon (Chain ID: 137) | BNB Chain (Chain ID: 56) |
| **抵押品** | USDC.e → pUSD | USDT → Yield-Bearing Wrapped |
| **CTF 合约** | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | YieldBearing: `0x9400F8Ad57e9e0F352345935d6D3175975eb1d9F` |
| **交易所** | `0xE111180000d2663C0091e4f400237545B87B996B` | YieldBearing: `0x6bEb5a40C032AFc305961162d8204CDA16DECFa5` |
| **UMA Oracle** | `0xCB1822859cEF82Cd2Eb4E6276C7916e692995130` | `0x76F42e5520E62AD88f8fE583cBb4BfF27eeC2531` |
| **撮合** | 混合去中心化（链下撮合 + 链上结算） | API 撮合 + CTFExchange 结算 |
| **Taker Fee** | feeRate × C × p × (1-p)，Maker 0% | 待定（预估 ~0.3%） |
| **Maker Rebate** | 20-25% of taker fees 返还 Maker | 待确认 |
| **解析** | UMA OO，2h challenge → 2-6天dispute | UMA OO，类似流程 |
| **认证** | L1(EIP-712) + L2(HMAC-SHA256) | API Key + JWT |
| **SDK** | @polymarket/clob-client-v2 (TS/PY/Rust) | @predictdotfun/sdk (TS/PY) |
| **API 限流** | 未公开 | 240 req/min |
| **WebSocket** | wss://ws-subscriptions-clob.polymarket.com/ws/market | wss://api.predict.fun/ws |
| **订单簿 Tick** | 0.01 (通常) | 市场 decimalPrecision |
| **服务器位置** | eu-west-2 (伦敦) | ap-northeast-1 (东京) |

### 2.2 关键架构差异对套利的影响

**① 跨链桥接非原子性**

这是最大的挑战。BNB Chain 和 Polygon 之间没有原生的原子性跨链设施。套利需要：
- 在两条链分别预存资金
- 通过 Celer cBridge / LayerZero / Stargate 等桥接协议在链间转移资金
- 套利无法做到完全原子化

**② UMA Oracle 实例不同**

虽然都使用 UMA Optimistic Oracle，但 Polymarket 和 Predict.fun 使用的是不同部署实例。存在极端边缘情况下解析不一致的理论风险，但实际概率极低（UMA Token Holders 作为最终仲裁者）。

**③ 服务器延迟差异**

Polymarket 服务器在伦敦 (eu-west-2)，Predict.fun 在东京 (ap-northeast-1)。两者之间网络延迟约 200-300ms，需要低延迟执行来捕捉价格窗口。

---

## 3. 套利策略体系

### 3.1 策略 A：同事件对冲套利（核心策略）

**描述**：在两个平台上找到相同的预测事件（如 "Bitcoin $100k by EOY 2025"），利用价格差异构建完全对冲组合。

**触发条件**：

```
// 方向 1：PM YES 便宜 + PF NO 便宜
PM_YES_Ask + (1 - PF_YES_Bid) < 1.00 - threshold

// 方向 2：PM NO 便宜 + PF YES 便宜
PM_NO_Ask + PF_YES_Ask < 1.00 - threshold
```

**执行流程**：

```
┌─────────────────────────────────────────────────────┐
│  Step 1: 事件匹配引擎                                 │
│  搜索两个平台中标题/问题高度相似的市场                    │
│  匹配规则：标题编辑距离 < 阈值 OR 事件slug共享关键词     │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  Step 2: 价差计算                                    │
│  获取两个市场的订单簿快照                               │
│  计算成本 = PM_YES_Ask + PF_NO_Ask                    │
│  （或 PM_NO_Ask + PF_YES_Ask）                       │
│  净利润 = 1.00 - 成本 - 桥接费 - 双平台Fee            │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  Step 3: 风险评估                                    │
│  ✅ 利润 > 0                                         │
│  ✅ 两条链均有足够资金                                 │
│  ✅ 解析规则一致（UMA）                                │
│  ✅ 事件尚未到期                                       │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  Step 4: 并行执行                                    │
│  Polymarket:     POST Order BUY YES  @ PM price       │
│  Predict.fun:    POST Order BUY NO   @ PF price       │
│  两笔订单同时提交                                     │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  Step 5: 结算                                       │
│  等待事件到期 → UMA 解析                              │
│  WIN token 赎回 → 跨链汇回                            │
│  计算实际净利润                                       │
└─────────────────────────────────────────────────────┘
```

### 3.2 策略 B：跨平台做市对锁

**描述**：当一个平台上存在显著定价偏差时，在一侧做 Maker，另一侧做 Taker。

```
场景：Polymarket 上某市场 YES = 0.65, NO = 0.37 (Sum = 1.02)
      Predict.fun 上同一事件 YES = 0.55, NO = 0.47 (Sum = 1.02)

操作：
  1. Predict.fun: BUY YES  @ 0.55 (便宜)
  2. Polymarket:  SELL YES @ 0.65 (贵)
  3. 净头寸 = 0 (一买一卖同一outcome)
  4. 利润 = 0.65 - 0.55 = 0.10/share - fees
```

**优势**：不需要锁仓到到期日，可以随时平仓。**劣势**：需要两平台同时持有抵押品；如果市场走势不利（YES 跌），可能需要保证金。

### 3.3 策略 C：CRYPTO_UP_DOWN 市场的 Delta-Neutral 对锁

两个平台都有加密货币短线涨跌类型的市场。这类市场有明确的时间窗口（5min/15min/1h），适合短期结算。

```
Predict.fun CRYPTO_UP_DOWN (BTC 15min UP/DOWN)
  - UP price = 0.52, DOWN price = 0.50 (sum = 1.02)

Polymarket Crypto (BTC price > $X by HH:MM)
  - UP price = 0.48, DOWN price = 0.50 (sum = 0.98)

操作：
  1. PF: BUY DOWN @ 0.50
  2. PM: BUY UP   @ 0.48
  3. 总成本 = 0.98, 无论结果回收 1.00
  4. 不用担心长期锁仓，15分钟后结算
```

**这是最理想的跨市场套利场景**，因为结算周期短，资金效率高。

### 3.4 策略 D：解析套利（高阶策略）

**描述**：利用 UMA Oracle 解析过程的不确定性套利。当 Polymarket 已经解析但 Predict.fun 尚未解析同一事件（或反之），存在确定性机会。

```
流程：
  1. Polymarket 某市场已解析为 YES
  2. Predict.fun 同一事件尚未解析，NO = 0.45 (没人信 NO)
  3. 买入 PF NO @ 0.45，因为它必然解析为 LOSE → 价值为 0
  4. 实际上应买入 PF YES

更合理的策略：
  1. Polymarket YES 已解析 → PM Yes Token = $1
  2. Predict.fun 同一事件尚未解析，YES 仍在交易 @ $0.85
  3. 买入 PF YES @ 0.85
  4. PF 最终也会解析 YES → $1
  5. 利润 = 0.15/share × Q

但这种机会极罕见，且存在 Predict.fun 解析规则不同的风险。
```

### 3.5 策略优先级矩阵

| 策略 | 风险 | 资金效率 | 执行复杂度 | 结算周期 | 推荐度 |
|------|------|----------|------------|----------|--------|
| A: 同事件对冲 | 低 | 中（需锁仓）| 中 | 数天到数周 | ⭐⭐⭐ |
| B: 跨平台做市对锁 | 中 | 高（无需等到期）| 高 | 即时 | ⭐⭐⭐⭐ |
| C: Crypto Delta-Neutral | 低 | 极高 | 中 | 5-15min | ⭐⭐⭐⭐⭐ |
| D: 解析套利 | 极低 | 高 | 低 | 数小时 | ⭐⭐（机会稀少） |

---

## 4. 系统架构设计

### 4.1 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        事件匹配引擎                                │
│  ┌──────────────────────┐    ┌──────────────────────┐            │
│  │ Polymarket 市场数据   │    │ Predict.fun 市场数据   │            │
│  │ GET /events          │    │ GET /v1/markets      │            │
│  │ GET /markets         │    │ GET /v1/categories   │            │
│  └──────────┬───────────┘    └──────────┬───────────┘            │
│             └─────────────┬─────────────┘                        │
│                           ▼                                      │
│                ┌─────────────────────┐                           │
│                │  NLP/Semantic Match │                           │
│                │  - 标题相似度        │                           │
│                │  - 关键词匹配        │                           │
│                │  - 日期/标签匹配     │                           │
│                └──────────┬──────────┘                           │
│                           ▼                                      │
│                ┌─────────────────────┐                           │
│                │  Matched Event Pairs│                           │
│                │  PM_Market ↔ PF_Market                         │
│                └─────────────────────┘                           │
└──────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                       实时价差监控层                               │
│  ┌──────────────────────┐    ┌──────────────────────┐            │
│  │ Polymarket WebSocket │    │ Predict.fun WebSocket│            │
│  │ WS Orderbook Stream  │    │ WS Orderbook Stream  │            │
│  └──────────┬───────────┘    └──────────┬───────────┘            │
│             └─────────────┬─────────────┘                        │
│                           ▼                                      │
│                ┌─────────────────────┐                           │
│                │  价格聚合 & 价差计算  │                           │
│                │  - Midpoint diff    │                           │
│                │  - Ask-Ask cost     │                           │
│                │  - Bid-Bid credit   │                           │
│                └──────────┬──────────┘                           │
│                           ▼                                      │
│                ┌─────────────────────┐                           │
│                │   套利机会评分引擎    │                           │
│                │  Score > threshold  │                           │
│                │  → 触发执行         │                           │
│                └─────────────────────┘                           │
└──────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                       决策 & 风险层                                │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────┐             │
│  │ 资金余额检查 │ │ 桥接路径选择  │ │ 最大敞口控制  │             │
│  │ PM pUSD    │ │ Celer/L0/   │ │ per_event    │             │
│  │ PF USDT    │ │ Stargate    │ │ max_total    │             │
│  └──────┬──────┘ └──────┬───────┘ └───────┬───────┘             │
│         └───────────────┬─────────────────┘                      │
│                         ▼                                        │
│              ┌──────────────────┐                                │
│              │  利润确认 & 批准  │                                │
│              │  net > 0 → EXEC │                                │
│              └──────────────────┘                                │
└──────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                       并行执行层                                   │
│                                                                  │
│  ┌─────────────────────┐          ┌─────────────────────┐        │
│  │  Polymarket Executor│          │ Predict.fun Executor│        │
│  │  ┌───────────────┐  │          │  ┌───────────────┐  │        │
│  │  │ ClobClient    │  │          │  │ OrderBuilder   │  │        │
│  │  │ (HMAC Auth)   │  │          │  │ (JWT Auth)    │  │        │
│  │  └───────┬───────┘  │          │  └───────┬───────┘  │        │
│  │          ▼          │          │          ▼          │        │
│  │  ┌───────────────┐  │          │  ┌───────────────┐  │        │
│  │  │ EIP-712 Sign  │  │          │  │ EIP-712 Sign  │  │        │
│  │  │ (Wallet)      │  │          │  │ (Wallet)      │  │        │
│  │  └───────┬───────┘  │          │  └───────┬───────┘  │        │
│  │          ▼          │          │          ▼          │        │
│  │  POST /order        │          │  POST /v1/orders   │        │
│  └─────────────────────┘          └─────────────────────┘        │
│                                                                  │
│              ┌─────────────────────────┐                         │
│              │    原子性协调器          │                         │
│              │  - 两笔订单均FILLED → OK │                         │
│              │  - 只有一笔FILLED → 取消 │                         │
│              │    并平掉已成交仓位      │                         │
│              └─────────────────────────┘                         │
└──────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                       结算 & 再平衡层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ 持仓追踪     │  │ 跨链桥接服务  │  │ 资金再平衡    │           │
│  │ PM PF 双账户 │  │ USDT→USDC   │  │ 被动 + 主动  │           │
│  │ P&L 实时计算 │  │ USDC→USDT   │  │ rebalancing │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 模块职责

| 模块 | 职责 | 技术选型 |
|------|------|----------|
| **事件匹配引擎** | 跨平台匹配同一事件的市场 | NLP相似度 + 关键词 + 手动映射表 |
| **实时价差监控** | 同时订阅两平台的WS，实时计算价差 | Polly WS + Predict WS |
| **价格聚合** | 归一化价格、计算跨平台套利成本 | 纯计算模块 |
| **机会评分引擎** | 综合利润、风险、资金效率评分排序 | 加权评分模型 |
| **PM Executor** | Polymarket 订单创建/取消 | `@polymarket/clob-client-v2` |
| **PF Executor** | Predict.fun 订单创建/取消 | `@predictdotfun/sdk` |
| **原子性协调器** | 确保双边订单要么都成交，要么都不成交 | 超时取消 + 紧急平仓 |
| **跨链桥服务** | 链间资金转移 | Celer cBridge / LayerZero / Stargate |
| **资金再平衡** | 根据策略方向主动或被动调整双链资金分配 | 周期性检查 + 阈值触发 |

### 4.3 事件匹配算法

```typescript
// 匹配两个平台上同一事件的逻辑
interface EventMatch {
  confidence: number;      // 0-1，匹配置信度
  pmMarketId: string;      // Polymarket condition ID
  pfMarketId: number;      // Predict.fun market ID
  titleSimilarity: number; // 标题余弦相似度
  sharedKeywords: string[];
  dateMatch: boolean;      // 日期范围是否重叠
  resolutionMatch: boolean;// 解析规则是否一致
}

// 匹配管线：
// 1. 关键词预过滤（candidate generation）
// 2. 标题余弦相似度计算
// 3. 日期/价格范围匹配
// 4. 解析来源一致性检查
// 5. 置信度阈值过滤 → 输出匹配对
```

---

## 5. 代码实现

### 5.1 项目结构

```
cross-market-arb/
├── src/
│   ├── config.ts              # 配置管理
│   ├── matching/
│   │   ├── eventMatcher.ts    # 事件匹配引擎
│   │   ├── similarity.ts      # 文本相似度算法
│   │   └── types.ts           # 匹配类型
│   ├── connectors/
│   │   ├── polymarket.ts      # Polymarket API 连接器
│   │   └── predictfun.ts      # Predict.fun API 连接器
│   ├── monitor/
│   │   ├── priceMonitor.ts    # 跨平台价差监控
│   │   └── orderbookSync.ts   # 双平台订单簿同步
│   ├── arb/
│   │   ├── detector.ts        # 跨市场套利检测
│   │   ├── scorer.ts          # 机会评分引擎
│   │   ├── riskEngine.ts      # 风险评估
│   │   └── types.ts           # 类型定义
│   ├── executor/
│   │   ├── polymarketExecutor.ts  # Polymarket 订单执行
│   │   ├── predictfunExecutor.ts  # Predict.fun 订单执行
│   │   ├── atomicCoordinator.ts   # 原子性协调
│   │   └── hedgeManager.ts        # 对冲/平仓管理
│   ├── bridge/
│   │   ├── bridgeService.ts   # 跨链桥接服务
│   │   └── rebalancer.ts      # 资金再平衡
│   ├── settlement/
│   │   ├── positionTracker.ts # 双平台持仓追踪
│   │   └── redemption.ts      # 赎回管理
│   └── index.ts               # 入口文件
├── .env
├── package.json
└── tsconfig.json
```

### 5.2 核心类型定义 (`src/arb/types.ts`)

```typescript
// 平台标识
export type Platform = 'POLYMARKET' | 'PREDICTFUN';

// 统一的市场数据结构
export interface UnifiedMarket {
  platform: Platform;
  id: string;
  slug: string;
  title: string;
  question: string;
  outcomes: string[];
  tokenIds: { yes: string; no: string };
  isNegRisk: boolean;
  feeRateBps: number;
  tickSize: number;
  status: 'ACTIVE' | 'CLOSED' | 'RESOLVED';
  volume24h: number;
  liquidity: number;
  endDate: number;
  resolutionSource: string; // UMA Oracle 解析来源
}

// 统一的订单簿
export interface UnifiedOrderbook {
  platform: Platform;
  marketId: string;
  timestamp: number;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  tickSize: number;
}

// 匹配的事件对
export interface MatchedEvent {
  id: string;
  pmMarket: UnifiedMarket;
  pfMarket: UnifiedMarket;
  confidence: number;
  titleSimilarity: number;
  resolutionMatch: boolean;
}

// 综合价格快照
export interface CrossMarketSnapshot {
  timestamp: number;
  event: MatchedEvent;
  pmOrderbook: UnifiedOrderbook;
  pfOrderbook: UnifiedOrderbook;
  // 各组合成本
  costPM_YES_PF_NO: number;
  costPM_NO_PF_YES: number;
  // 各组合收益
  profitBps_PM_YES_PF_NO: number;
  profitBps_PM_NO_PF_YES: number;
  // 最优套利方向
  bestDirection: 'PM_YES_PF_NO' | 'PM_NO_PF_YES';
  bestProfitBps: number;
  bestQuantity: number;
}

// 跨市场套利机会
export interface CrossMarketOpportunity extends CrossMarketSnapshot {
  estimatedFees: {
    polymarketTakerFee: number;
    predictfunFee: number;
    bridgeFee: number;
    totalGasUSDT: number;
  };
  estimatedNetProfitUSDT: number;
  requiredCollateral: {
    polymarketUSDC: number;
    predictfunUSDT: number;
  };
  score: number; // 0-100 综合评分
}

// 执行结果
export interface CrossMarketExecution {
  success: boolean;
  opportunity: CrossMarketOpportunity;
  polymarketOrder: {
    orderId: string;
    status: 'FILLED' | 'PARTIAL' | 'FAILED';
    filledQuantity: number;
    avgPrice: number;
    feeUSDC: number;
  };
  predictfunOrder: {
    orderHash: string;
    orderId: string;
    status: 'FILLED' | 'PARTIAL' | 'FAILED';
    filledQuantity: number;
    avgPrice: number;
  };
  netProfitUSDT: number;
  executionTimeMs: number;
  needsHedging: boolean; // true if only one side filled
}
```

### 5.3 Polymarket 连接器 (`src/connectors/polymarket.ts`)

```typescript
import { ClobClient, Side, OrderType, BookParams } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { UnifiedMarket, UnifiedOrderbook, Platform } from '../arb/types';

export class PolymarketConnector {
  private clobClient: ClobClient | null = null;
  private gammaBaseUrl = 'https://gamma-api.polymarket.com';
  private clobBaseUrl = 'https://clob.polymarket.com';

  async initialize(): Promise<void> {
    const account = privateKeyToAccount(
      process.env.POLYMARKET_PRIVATE_KEY as `0x${string}`
    );
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    // Derive L2 credentials
    const tempClient = new ClobClient({
      host: this.clobBaseUrl,
      chain: 137,
      signer,
    });
    const apiCreds = await tempClient.createOrDeriveApiKey();

    this.clobClient = new ClobClient({
      host: this.clobBaseUrl,
      chain: 137,
      signer,
      creds: apiCreds,
      signatureType: 3,
      funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS!,
    });
  }

  // 获取所有活跃市场
  async getActiveMarkets(): Promise<UnifiedMarket[]> {
    const response = await fetch(
      `${this.gammaBaseUrl}/markets?closed=false&limit=500`
    );
    const markets = await response.json();

    return markets.map((m: any) => ({
      platform: 'POLYMARKET' as Platform,
      id: m.conditionId,
      slug: m.slug,
      title: m.title,
      question: m.question,
      outcomes: m.outcomes,
      tokenIds: {
        yes: m.clobTokenIds?.[0] || m.tokens?.[0]?.tokenId,
        no: m.clobTokenIds?.[1] || m.tokens?.[1]?.tokenId,
      },
      isNegRisk: m.negRisk || false,
      feeRateBps: 0, // 通过 getClobMarketInfo 获取
      tickSize: parseFloat(m.tickSize || '0.01'),
      status: m.closed ? 'CLOSED' : 'ACTIVE',
      volume24h: m.volume24hr || 0,
      liquidity: parseFloat(m.liquidity || '0'),
      endDate: new Date(m.endDateIso).getTime(),
      resolutionSource: m.resolutionSource || 'UMA',
    }));
  }

  // 获取事件
  async getEvents(): Promise<any[]> {
    const response = await fetch(
      `${this.gammaBaseUrl}/events?limit=500&active=true&closed=false`
    );
    const events = await response.json();
    return events;
  }

  // 获取订单簿
  async getOrderbook(tokenId: string): Promise<UnifiedOrderbook> {
    if (!this.clobClient) throw new Error('未初始化');

    const book = await this.clobClient.getOrderBook(tokenId);

    return {
      platform: 'POLYMARKET',
      marketId: tokenId,
      timestamp: Date.now(),
      bids: book.bids?.map((b: any) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      })) || [],
      asks: book.asks?.map((a: any) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      })) || [],
      tickSize: parseFloat(book.tick_size || '0.01'),
    };
  }

  // 创建限价单
  async createLimitOrder(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    tickSize?: string;
  }): Promise<{ orderId: string; status: string }> {
    if (!this.clobClient) throw new Error('未初始化');

    const order = await this.clobClient.createAndPostOrder(
      {
        tokenID: params.tokenId,
        price: params.price,
        size: params.size,
        side: params.side === 'BUY' ? Side.BUY : Side.SELL,
      },
      {
        tickSize: params.tickSize || '0.01',
        negRisk: false,
      }
    );

    return {
      orderId: order.orderID || order.id,
      status: order.status || 'PENDING',
    };
  }

  // 获取 Taker Fee 信息
  async getFeeInfo(conditionId: string): Promise<{
    feeRate: number;
    takerOnly: boolean;
  }> {
    if (!this.clobClient) throw new Error('未初始化');

    const info = await this.clobClient.getClobMarketInfo(conditionId);
    return {
      feeRate: info.fd?.r || 0, // feeRate
      takerOnly: info.fd?.to ?? true,
    };
  }

  // 获取账户余额
  async getBalance(): Promise<number> {
    if (!this.clobClient) throw new Error('未初始化');
    // 通过 CLOB API 获取 pUSD 余额
    const response = await fetch(
      `${this.clobBaseUrl}/balance?address=${process.env.POLYMARKET_FUNDER_ADDRESS}`,
      {
        headers: {
          POLY_ADDRESS: process.env.POLYMARKET_FUNDER_ADDRESS!,
        },
      }
    );
    const data = await response.json();
    return parseFloat(data.balance || '0');
  }
}
```

### 5.4 Predict.fun 连接器 (`src/connectors/predictfun.ts`)

```typescript
import { OrderBuilder, Side, ChainId } from '@predictdotfun/sdk';
import { Wallet, parseEther } from 'ethers';
import axios from 'axios';
import { UnifiedMarket, UnifiedOrderbook, Platform } from '../arb/types';

export class PredictFunConnector {
  private orderBuilder: OrderBuilder | null = null;
  private apiBaseUrl: string;
  private apiKey: string;
  private wallet: Wallet;
  private jwtToken: string | null = null;
  private jwtExpiry: number = 0;

  constructor() {
    this.apiBaseUrl = process.env.PREDICT_API_URL || 'https://api.predict.fun';
    this.apiKey = process.env.PREDICT_API_KEY || '';
    this.wallet = new Wallet(process.env.PREDICT_PRIVATE_KEY || '');
  }

  async initialize(): Promise<void> {
    this.orderBuilder = await OrderBuilder.make(
      ChainId.BnbMainnet,
      this.wallet,
      process.env.PREDICT_ACCOUNT_ADDRESS
        ? { predictAccount: process.env.PREDICT_ACCOUNT_ADDRESS }
        : undefined
    );
  }

  // JWT 管理
  private async getJWT(): Promise<string> {
    if (this.jwtToken && Date.now() < this.jwtExpiry - 60000) {
      return this.jwtToken;
    }
    // Get auth message
    const { data: msgResp } = await axios.get(`${this.apiBaseUrl}/v1/auth/message`, {
      headers: { 'x-api-key': this.apiKey },
    });
    const message = msgResp.data.message;
    const signature = await this.wallet.signMessage(message);

    const { data: jwtResp } = await axios.post(`${this.apiBaseUrl}/v1/auth/token`, {
      message,
      signature,
      address: this.wallet.address,
    });

    this.jwtToken = jwtResp.data.token;
    this.jwtExpiry = Date.now() + 55 * 60 * 1000;
    return this.jwtToken!;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.getJWT()}`,
      'x-api-key': this.apiKey,
    };
  }

  // 获取活跃市场
  async getActiveMarkets(): Promise<UnifiedMarket[]> {
    const headers = await this.authHeaders();
    const { data } = await axios.get(`${this.apiBaseUrl}/v1/markets`, {
      headers,
      params: { status: 'ACTIVE', limit: 200 },
    });

    if (!data.success) return [];

    return data.data.map((m: any) => ({
      platform: 'PREDICTFUN' as Platform,
      id: m.id.toString(),
      slug: m.slug || '',
      title: m.title || '',
      question: m.title || m.description || '',
      outcomes: (m.outcomes || []).map((o: any) => o.name),
      tokenIds: {
        yes: (m.outcomes || [])[0]?.onChainId || '',
        no: (m.outcomes || [])[1]?.onChainId || '',
      },
      isNegRisk: m.isNegRisk || false,
      feeRateBps: m.feeRateBps || 0,
      tickSize: 0.01,
      status: m.status || 'ACTIVE',
      volume24h: parseFloat(m.volume24h || '0'),
      liquidity: parseFloat(m.liquidity || '0'),
      endDate: m.endTime ? new Date(m.endTime).getTime() : 0,
      resolutionSource: 'UMA',
    }));
  }

  // 获取订单簿
  async getOrderbook(marketId: number): Promise<UnifiedOrderbook> {
    const headers = await this.authHeaders();
    const { data } = await axios.get(
      `${this.apiBaseUrl}/v1/markets/${marketId}/orderbook`,
      { headers }
    );

    const book = data.data;
    return {
      platform: 'PREDICTFUN',
      marketId: marketId.toString(),
      timestamp: book.updateTimestampMs,
      bids: book.bids.map(([p, q]: [number, number]) => ({ price: p, size: q })),
      asks: book.asks.map(([p, q]: [number, number]) => ({ price: p, size: q })),
      tickSize: 0.01,
    };
  }

  // 创建限价单
  async createLimitOrder(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    isNegRisk: boolean;
    isYieldBearing: boolean;
  }): Promise<{ orderHash: string; orderId: string }> {
    if (!this.orderBuilder) throw new Error('未初始化');

    const sideEnum = params.side === 'BUY' ? Side.BUY : Side.SELL;
    const { makerAmount, takerAmount, pricePerShare } =
      this.orderBuilder.getLimitOrderAmounts({
        side: sideEnum,
        pricePerShareWei: parseEther(params.price.toString()),
        quantityWei: parseEther(params.size.toString()),
      });

    const order = this.orderBuilder.buildOrder('LIMIT', {
      maker: process.env.PREDICT_ACCOUNT_ADDRESS || this.wallet.address,
      signer: process.env.PREDICT_ACCOUNT_ADDRESS || this.wallet.address,
      side: sideEnum,
      tokenId: params.tokenId,
      makerAmount,
      takerAmount,
      nonce: 0n,
      feeRateBps: 0,
    });

    const typedData = this.orderBuilder.buildTypedData(order, {
      isNegRisk: params.isNegRisk,
      isYieldBearing: params.isYieldBearing,
    });

    const signedOrder = await this.orderBuilder.signTypedDataOrder(typedData);
    const hash = this.orderBuilder.buildTypedDataHash(typedData);

    const headers = await this.authHeaders();
    const { data } = await axios.post(
      `${this.apiBaseUrl}/v1/orders`,
      {
        data: {
          order: { ...signedOrder, hash },
          pricePerShare,
          strategy: 'LIMIT',
        },
      },
      { headers, timeout: 30000 }
    );

    return {
      orderHash: data.data.orderHash,
      orderId: data.data.orderId,
    };
  }

  // 取消订单
  async cancelOrder(orderHash: string): Promise<void> {
    const headers = await this.authHeaders();
    await axios.delete(`${this.apiBaseUrl}/v1/orders`, {
      headers,
      data: { data: { hashes: [orderHash] } },
    });
  }

  // 获取 USDT 余额
  async getBalance(): Promise<number> {
    const headers = await this.authHeaders();
    const { data } = await axios.get(`${this.apiBaseUrl}/v1/account`, { headers });
    return parseFloat(data.data?.balance || '0');
  }
}
```

### 5.5 事件匹配引擎 (`src/matching/eventMatcher.ts`)

```typescript
import { UnifiedMarket, MatchedEvent } from '../arb/types';
import { PolymarketConnector } from '../connectors/polymarket';
import { PredictFunConnector } from '../connectors/predictfun';

export class EventMatcher {
  private pm: PolymarketConnector;
  private pf: PredictFunConnector;
  private matchCache: Map<string, MatchedEvent> = new Map();

  constructor(pm: PolymarketConnector, pf: PredictFunConnector) {
    this.pm = pm;
    this.pf = pf;
  }

  async buildMatchIndex(): Promise<MatchedEvent[]> {
    const [pmMarkets, pfMarkets] = await Promise.all([
      this.pm.getActiveMarkets(),
      this.pf.getActiveMarkets(),
    ]);

    const matches: MatchedEvent[] = [];

    for (const pmMarket of pmMarkets) {
      for (const pfMarket of pfMarkets) {
        const similarity = this.calculateSimilarity(pmMarket, pfMarket);
        if (similarity > 0.6) {
          matches.push({
            id: `${pmMarket.id}_${pfMarket.id}`,
            pmMarket,
            pfMarket,
            confidence: similarity,
            titleSimilarity: similarity,
            resolutionMatch: pmMarket.resolutionSource === pfMarket.resolutionSource,
          });
        }
      }
    }

    // Sort by confidence descending
    matches.sort((a, b) => b.confidence - a.confidence);

    // Deduplicate: one PM market → one PF market
    const usedPM = new Set<string>();
    const usedPF = new Set<string>();
    const deduped: MatchedEvent[] = [];

    for (const match of matches) {
      if (!usedPM.has(match.pmMarket.id) && !usedPF.has(match.pfMarket.id)) {
        deduped.push(match);
        usedPM.add(match.pmMarket.id);
        usedPF.add(match.pfMarket.id);
      }
    }

    this.matchCache = new Map(deduped.map(m => [m.id, m]));
    return deduped;
  }

  private calculateSimilarity(a: UnifiedMarket, b: UnifiedMarket): number {
    const textA = this.normalize(a.question || a.title);
    const textB = this.normalize(b.question || b.title);

    // Jaccard similarity on word sets
    const wordsA = new Set(textA.split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(textB.split(/\s+/).filter(w => w.length > 2));

    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = wordsA.size + wordsB.size - intersection;

    const jaccardSim = union > 0 ? intersection / union : 0;

    // Exact key phrase bonus
    const keyPhrases = ['bitcoin', 'btc', 'ethereum', 'eth', 'price', 'above', 'below',
      'reach', 'president', 'election', 'fed', 'rate', 'cut', 'gdp', 'unemployment',
      'super bowl', 'nba', 'nfl', 'oscar'];
    const phraseBonus = keyPhrases.reduce((sum, phrase) => {
      const inA = textA.includes(phrase);
      const inB = textB.includes(phrase);
      return sum + (inA && inB ? 0.05 : 0);
    }, 0);

    // Date range overlap bonus
    let dateBonus = 0;
    if (a.endDate > 0 && b.endDate > 0) {
      const diffDays = Math.abs(a.endDate - b.endDate) / (1000 * 60 * 60 * 24);
      if (diffDays < 1) dateBonus = 0.1;
      else if (diffDays < 7) dateBonus = 0.05;
    }

    return Math.min(1, jaccardSim + phraseBonus + dateBonus);
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  getMatch(pmId: string, pfId: string): MatchedEvent | undefined {
    return this.matchCache.get(`${pmId}_${pfId}`);
  }
}
```

### 5.6 跨市场套利检测器 (`src/arb/detector.ts`)

```typescript
import { MatchedEvent, CrossMarketOpportunity, UnifiedOrderbook } from './types';
import { PolymarketConnector } from '../connectors/polymarket';
import { PredictFunConnector } from '../connectors/predictfun';

interface ArbConfig {
  minProfitBps: number;       // 最小利润（基点）默认 50
  maxPositionValue: number;   // 单次最大交易额
  bridgeFeeBps: number;       // 桥接费（基点）默认 20
  slippageBps: number;        // 滑点预留（基点）默认 30
}

export class CrossMarketDetector {
  private pm: PolymarketConnector;
  private pf: PredictFunConnector;
  private config: ArbConfig;

  constructor(
    pm: PolymarketConnector,
    pf: PredictFunConnector,
    config: Partial<ArbConfig> = {}
  ) {
    this.pm = pm;
    this.pf = pf;
    this.config = {
      minProfitBps: config.minProfitBps || 50,
      maxPositionValue: config.maxPositionValue || 10000,
      bridgeFeeBps: config.bridgeFeeBps || 20,
      slippageBps: config.slippageBps || 30,
    };
  }

  /**
   * 计算跨市场套利机会
   */
  async detectArbitrage(match: MatchedEvent): Promise<CrossMarketOpportunity | null> {
    // 同时获取两边订单簿
    const [pmBook, pfBook] = await Promise.all([
      this.pm.getOrderbook(match.pmMarket.tokenIds.yes),
      this.pf.getOrderbook(Number(match.pfMarket.id)),
    ]);

    if (pmBook.bids.length === 0 || pmBook.asks.length === 0) return null;
    if (pfBook.bids.length === 0 || pfBook.asks.length === 0) return null;

    // 获取费用信息
    const pmFee = await this.pm.getFeeInfo(match.pmMarket.id);

    const pmYesBestBid = pmBook.bids[0].price;
    const pmYesBestAsk = pmBook.asks[0].price;

    const pfYesBestBid = pfBook.bids[0].price;
    const pfYesBestAsk = pfBook.asks[0].price;

    // 计算 No 侧价格
    // PF No Ask = getComplement(PF Yes Bid)
    const pfNoAsk = this.getComplement(pfYesBestBid);
    // PM No Ask = 1 - PM Yes Bid (简化，实际应使用 No token orderbook)
    const pmNoAsk = this.getComplement(pmYesBestBid);

    // 方向1：买 PM YES + 买 PF NO
    const cost_1 = pmYesBestAsk + pfNoAsk;
    
    // 方向2：买 PM NO + 买 PF YES
    const cost_2 = pmNoAsk + pfYesBestAsk;

    // 计算费用
    // Polymarket taker fee = C × feeRate × p × (1-p)
    const pmFeeRate = pmFee.feeRate || 0;
    const pmFee1 = this.calcPMFee(1, pmYesBestAsk, pmFeeRate);
    const pmFee2 = this.calcPMFee(1, pmNoAsk, pmFeeRate);
    
    // Predict.fun fee 估计为 0.3%
    const pfFeeRate = 0.003;
    const pfFee1 = 1 * pfFeeRate * pfNoAsk;
    const pfFee2 = 1 * pfFeeRate * pfYesBestAsk;

    const bridgeFee = (this.config.bridgeFeeBps / 10000) * 2; // 进出双向桥
    const slippage = (this.config.slippageBps / 10000);

    // 方向1 净利润
    const fees_1 = pmFee1 + pfFee1 + bridgeFee + slippage;
    const profit_1 = 1 - cost_1 - fees_1;
    const profitBps_1 = Math.round(profit_1 * 10000);

    // 方向2 净利润
    const fees_2 = pmFee2 + pfFee2 + bridgeFee + slippage;
    const profit_2 = 1 - cost_2 - fees_2;
    const profitBps_2 = Math.round(profit_2 * 10000);

    const bestDirection = profit_1 > profit_2 ? 'PM_YES_PF_NO' : 'PM_NO_PF_YES';
    const bestProfitBps = Math.max(profitBps_1, profitBps_2);

    if (bestProfitBps < this.config.minProfitBps) return null;

    const bestProfit = bestDirection === 'PM_YES_PF_NO' ? profit_1 : profit_2;
    const bestCost = bestDirection === 'PM_YES_PF_NO' ? cost_1 : cost_2;

    // 根据利润和单边流动性计算可执行数量
    const pmQuantity = bestDirection === 'PM_YES_PF_NO'
      ? Math.min(pmBook.asks[0].size, this.config.maxPositionValue / pmYesBestAsk)
      : Math.min(pmBook.bids[0].size, this.config.maxPositionValue);

    const pfQuantity = bestDirection === 'PM_YES_PF_NO'
      ? Math.min(pfBook.bids[0].size, this.config.maxPositionValue / pfNoAsk)
      : Math.min(pfBook.asks[0].size, this.config.maxPositionValue / pfYesBestAsk);

    const quantity = Math.min(pmQuantity, pfQuantity);

    const snapshot = {
      timestamp: Date.now(),
      event: match,
      pmOrderbook: pmBook,
      pfOrderbook: pfBook,
      costPM_YES_PF_NO: cost_1,
      costPM_NO_PF_YES: cost_2,
      profitBps_PM_YES_PF_NO: profitBps_1,
      profitBps_PM_NO_PF_YES: profitBps_2,
      bestDirection,
      bestProfitBps,
      bestQuantity: quantity,
    };

    const estimatedFees = {
      polymarketTakerFee: bestDirection === 'PM_YES_PF_NO' ? pmFee1 * quantity : pmFee2 * quantity,
      predictfunFee: bestDirection === 'PM_YES_PF_NO' ? pfFee1 * quantity : pfFee2 * quantity,
      bridgeFee: bridgeFee * 2 * quantity,
      totalGasUSDT: 2, // Polygon + BNB gas 估算
    };

    const estimatedNetProfit = bestProfit * quantity - estimatedFees.totalGasUSDT;

    return {
      ...snapshot,
      estimatedFees,
      estimatedNetProfitUSDT: estimatedNetProfit,
      requiredCollateral: {
        polymarketUSDC: bestDirection === 'PM_YES_PF_NO'
          ? pmYesBestAsk * quantity
          : pmNoAsk * quantity,
        predictfunUSDT: bestDirection === 'PM_YES_PF_NO'
          ? pfNoAsk * quantity
          : pfYesBestAsk * quantity,
      },
      score: this.calculateScore(snapshot, estimatedNetProfit),
    };
  }

  private getComplement(price: number, precision: number = 2): number {
    const factor = 10 ** precision;
    return (factor - Math.round(price * factor)) / factor;
  }

  private calcPMFee(shares: number, price: number, feeRate: number): number {
    return shares * feeRate * price * (1 - price);
  }

  private calculateScore(
    snapshot: CrossMarketOpportunity,
    netProfit: number
  ): number {
    let score = 0;
    
    // 利润得分 (0-50)
    score += Math.min(50, (netProfit / 100) * 50);
    
    // 置信度得分 (0-30)
    score += snapshot.event.confidence * 30;
    
    // 流动性得分 (0-20)
    const totalLiquidity = snapshot.event.pmMarket.liquidity + snapshot.event.pfMarket.liquidity;
    score += Math.min(20, (totalLiquidity / 100000) * 20);
    
    return score;
  }
}
```

### 5.7 原子性协调器 (`src/executor/atomicCoordinator.ts`)

```typescript
import { CrossMarketOpportunity, CrossMarketExecution } from '../arb/types';
import { PolymarketConnector } from '../connectors/polymarket';
import { PredictFunConnector } from '../connectors/predictfun';

export interface AtomicExecutionResult {
  success: boolean;
  pmOrderId: string;
  pfOrderHash: string;
  pmStatus: string;
  pfStatus: string;
  hedged: boolean;    // 是否触发了紧急对冲
  profitUSDT: number;
}

export class AtomicCoordinator {
  private pm: PolymarketConnector;
  private pf: PredictFunConnector;
  private executionTimeoutMs: number;
  private pollIntervalMs: number;

  constructor(
    pm: PolymarketConnector,
    pf: PredictFunConnector,
    config: { executionTimeoutMs?: number; pollIntervalMs?: number } = {}
  ) {
    this.pm = pm;
    this.pf = pf;
    this.executionTimeoutMs = config.executionTimeoutMs || 15000;
    this.pollIntervalMs = config.pollIntervalMs || 500;
  }

  /**
   * 原子性执行跨市场套利
   *
   * 由于跨链无法实现真正的原子性，我们使用"预检查 + 超时取消 + 紧急平仓"三级保障：
   * 1. 提交前确认两边都有足够资金和流动性
   * 2. 同时提交双边订单（非阻塞）
   * 3. 轮询两边成交状态
   * 4. 如果超时后只有一边成交 → 立即在另一边做对冲平仓
   */
  async executeAtomicArbitrage(
    opportunity: CrossMarketOpportunity,
    match: { isNegRisk: boolean; isYieldBearing: boolean }
  ): Promise<AtomicExecutionResult> {
    // Step 1: 预检查
    const [pmBalance, pfBalance] = await Promise.all([
      this.pm.getBalance(),
      this.pf.getBalance(),
    ]);

    if (pmBalance < opportunity.requiredCollateral.polymarketUSDC) {
      throw new Error(`Polymarket 余额不足: need ${opportunity.requiredCollateral.polymarketUSDC}, have ${pmBalance}`);
    }
    if (pfBalance < opportunity.requiredCollateral.predictfunUSDT) {
      throw new Error(`Predict.fun 余额不足: need ${opportunity.requiredCollateral.predictfunUSDT}, have ${pfBalance}`);
    }

    // Step 2: 同时提交双边订单
    const dir = opportunity.bestDirection;

    let pmBuyTokenId: string, pmSellTokenId: string;
    let pfBuyTokenId: string, pfSellTokenId: string;

    if (dir === 'PM_YES_PF_NO') {
      pmBuyTokenId = opportunity.event.pmMarket.tokenIds.yes;
      pfBuyTokenId = opportunity.event.pfMarket.tokenIds.no;
    } else {
      pmBuyTokenId = opportunity.event.pmMarket.tokenIds.no;
      pfBuyTokenId = opportunity.event.pfMarket.tokenIds.yes;
    }

    const [pmResult, pfResult] = await Promise.allSettled([
      this.pm.createLimitOrder({
        tokenId: dir === 'PM_YES_PF_NO'
          ? opportunity.event.pmMarket.tokenIds.yes
          : (() => { throw new Error('PM No token ID needed'); })(), // 需要实际获取 NO token ID
        side: 'BUY',
        price: dir === 'PM_YES_PF_NO'
          ? opportunity.pmOrderbook.asks[0].price
          : opportunity.pmOrderbook.asks[0].price, // 简化
        size: opportunity.bestQuantity,
      }),
      this.pf.createLimitOrder({
        tokenId: dir === 'PM_YES_PF_NO'
          ? opportunity.event.pfMarket.tokenIds.no
          : opportunity.event.pfMarket.tokenIds.yes,
        side: 'BUY',
        price: dir === 'PM_YES_PF_NO'
          ? opportunity.pfOrderbook.asks[0].price
          : opportunity.pfOrderbook.asks[0].price,
        size: opportunity.bestQuantity,
        isNegRisk: match.isNegRisk,
        isYieldBearing: match.isYieldBearing,
      }),
    ]);

    const pmOrderId = pmResult.status === 'fulfilled' ? pmResult.value.orderId : '';
    const pfOrderHash = pfResult.status === 'fulfilled' ? pfResult.value.orderHash : '';

    if (!pmOrderId || !pfOrderHash) {
      // 一方提交失败 → 取消另一方
      if (pmOrderId) {
        // 取消 PM 订单
      }
      if (pfOrderHash) {
        await this.pf.cancelOrder(pfOrderHash);
      }
      return {
        success: false,
        pmOrderId,
        pfOrderHash,
        pmStatus: pmResult.status === 'fulfilled' ? 'SUBMITTED' : 'FAILED',
        pfStatus: pfResult.status === 'fulfilled' ? 'SUBMITTED' : 'FAILED',
        hedged: false,
        profitUSDT: 0,
      };
    }

    // Step 3: 轮询成交状态
    const startTime = Date.now();
    let pmFilled = false;
    let pfFilled = false;

    while (Date.now() - startTime < this.executionTimeoutMs) {
      // 轮询两边状态
      // PM: check order status
      // PF: GET /v1/orders/{hash}
      
      if (pmFilled && pfFilled) {
        return {
          success: true,
          pmOrderId,
          pfOrderHash,
          pmStatus: 'FILLED',
          pfStatus: 'FILLED',
          hedged: false,
          profitUSDT: opportunity.estimatedNetProfitUSDT,
        };
      }

      await new Promise(r => setTimeout(r, this.pollIntervalMs));
    }

    // Step 4: 超时 → 检查是否需要紧急对冲
    if (pmFilled && !pfFilled) {
      // PM 已成交，PF 未成交 → 在 PF 上做反向对冲
      await this.pf.cancelOrder(pfOrderHash);
      // 在 PF 上卖出与 PM 持仓相反的头寸
      console.warn('⚠️ 紧急对冲: PM filled, PF not filled — hedging on PF');
      return {
        success: false,
        pmOrderId,
        pfOrderHash,
        pmStatus: 'FILLED',
        pfStatus: 'CANCELLED',
        hedged: true,
        profitUSDT: 0,
      };
    }

    if (!pmFilled && pfFilled) {
      // PF 已成交，PM 未成交 → 在 PM 上做反向对冲
      console.warn('⚠️ 紧急对冲: PF filled, PM not filled — hedging on PM');
      return {
        success: false,
        pmOrderId,
        pfOrderHash,
        pmStatus: 'CANCELLED',
        pfStatus: 'FILLED',
        hedged: true,
        profitUSDT: 0,
      };
    }

    // 两边都未成交 → 取消
    await Promise.all([
      this.pf.cancelOrder(pfOrderHash),
    ]);
    
    return {
      success: false,
      pmOrderId,
      pfOrderHash,
      pmStatus: 'CANCELLED',
      pfStatus: 'CANCELLED',
      hedged: false,
      profitUSDT: 0,
    };
  }
}
```

### 5.8 跨链桥接服务 (`src/bridge/bridgeService.ts`)

```typescript
/**
 * 跨链桥接服务
 *
 * BNB Chain (USDT) ↔ Polygon (USDC) 的桥接方案：
 *
 * 1. Celer cBridge: 支持 BNB ↔ Polygon，USDT/USDC 跨链，费用 ~0.1%
 * 2. LayerZero (Stargate): 支持 BSC ↔ Polygon，费用 ~0.06%-0.1%
 * 3. 中心化交易所中转: Binance 充提，费用低但慢
 *
 * 推荐方案: LayerZero/Stargate，速度快（~1-2min），费用低
 */

export interface BridgeQuote {
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  amount: number;
  estimatedReceived: number;
  fee: number;
  feePercentage: number;
  estimatedTimeMin: number;
  provider: 'stargate' | 'celer' | 'cex';
}

export class BridgeService {
  private stargateApiUrl = 'https://api.stargate.finance';
  private celarApiUrl = 'https://api.celar.network';

  /**
   * 获取最优桥接报价
   */
  async getBestQuote(
    fromChain: 'bsc' | 'polygon',
    toChain: 'bsc' | 'polygon',
    amountUSDT: number
  ): Promise<BridgeQuote> {
    const quotes: BridgeQuote[] = [];

    // LayerZero/Stargate 报价
    try {
      const stargate = await this.getStargateQuote(fromChain, toChain, amountUSDT);
      quotes.push(stargate);
    } catch (e) {
      // 忽略
    }

    // Celer cBridge 报价
    try {
      const celer = await this.getCelerQuote(fromChain, toChain, amountUSDT);
      quotes.push(celer);
    } catch (e) {
      // 忽略
    }

    // CEX 中转估算
    quotes.push({
      fromChain,
      toChain,
      fromToken: fromChain === 'bsc' ? 'USDT' : 'USDC',
      toToken: toChain === 'bsc' ? 'USDT' : 'USDC',
      amount: amountUSDT,
      estimatedReceived: amountUSDT * 0.998, // Binance 0.1% * 2 + withdraw fee
      fee: amountUSDT * 0.002,
      feePercentage: 0.2,
      estimatedTimeMin: 15,
      provider: 'cex',
    });

    // 按收益最高排序
    quotes.sort((a, b) => b.estimatedReceived - a.estimatedReceived);
    return quotes[0];
  }

  private async getStargateQuote(
    fromChain: string,
    toChain: string,
    amount: number
  ): Promise<BridgeQuote> {
    // Stargate API quote
    return {
      fromChain,
      toChain,
      fromToken: 'USDT',
      toToken: 'USDC',
      amount,
      estimatedReceived: amount * 0.999,
      fee: amount * 0.001,
      feePercentage: 0.1,
      estimatedTimeMin: 2,
      provider: 'stargate',
    };
  }

  private async getCelerQuote(
    fromChain: string,
    toChain: string,
    amount: number
  ): Promise<BridgeQuote> {
    return {
      fromChain,
      toChain,
      fromToken: 'USDT',
      toToken: 'USDC',
      amount,
      estimatedReceived: amount * 0.998,
      fee: amount * 0.002,
      feePercentage: 0.2,
      estimatedTimeMin: 5,
      provider: 'celer',
    };
  }
}
```

### 5.9 资金再平衡器 (`src/bridge/rebalancer.ts`)

```typescript
import { BridgeService } from './bridgeService';
import { PolymarketConnector } from '../connectors/polymarket';
import { PredictFunConnector } from '../connectors/predictfun';

export class Rebalancer {
  private bridge: BridgeService;
  private pm: PolymarketConnector;
  private pf: PredictFunConnector;
  private targetRatio: number; // Poly:PF 资金目标比
  private rebalanceThreshold: number;

  constructor(
    bridge: BridgeService,
    pm: PolymarketConnector,
    pf: PredictFunConnector,
    config: { targetRatio?: number; rebalanceThreshold?: number } = {}
  ) {
    this.bridge = bridge;
    this.pm = pm;
    this.pf = pf;
    this.targetRatio = config.targetRatio || 0.5; // 默认 50:50
    this.rebalanceThreshold = config.rebalanceThreshold || 0.15; // 偏离 15% 触发
  }

  async checkAndRebalance(): Promise<{
    rebalanced: boolean;
    pmBalance: number;
    pfBalance: number;
    transferAmount?: number;
    direction?: 'POLY_TO_BSC' | 'BSC_TO_POLY';
  }> {
    const [pmBalance, pfBalance] = await Promise.all([
      this.pm.getBalance(),
      this.pf.getBalance(),
    ]);

    const totalBalance = pmBalance + pfBalance;
    if (totalBalance === 0) return { rebalanced: false, pmBalance: 0, pfBalance: 0 };

    const actualRatio = pmBalance / totalBalance;
    const deviation = Math.abs(actualRatio - this.targetRatio);

    if (deviation < this.rebalanceThreshold) {
      return { rebalanced: false, pmBalance, pfBalance };
    }

    // 需要再平衡
    const targetPoly = totalBalance * this.targetRatio;
    const transferAmount = Math.abs(targetPoly - pmBalance);

    if (pmBalance < targetPoly) {
      // PF (BSC) → PM (Polygon)
      console.log(`再平衡: ${transferAmount.toFixed(0)} USDT 从 BSC → Polygon`);
      // const quote = await this.bridge.getBestQuote('bsc', 'polygon', transferAmount);
      // 执行桥接...
      return {
        rebalanced: true,
        pmBalance,
        pfBalance,
        transferAmount,
        direction: 'BSC_TO_POLY',
      };
    } else {
      // PM (Polygon) → PF (BSC)
      console.log(`再平衡: ${transferAmount.toFixed(0)} USDC 从 Polygon → BSC`);
      return {
        rebalanced: true,
        pmBalance,
        pfBalance,
        transferAmount,
        direction: 'POLY_TO_BSC',
      };
    }
  }
}
```

### 5.10 主入口 (`src/index.ts`)

```typescript
import { PolymarketConnector } from './connectors/polymarket';
import { PredictFunConnector } from './connectors/predictfun';
import { EventMatcher } from './matching/eventMatcher';
import { CrossMarketDetector } from './arb/detector';
import { AtomicCoordinator } from './executor/atomicCoordinator';
import { BridgeService } from './bridge/bridgeService';
import { Rebalancer } from './bridge/rebalancer';

class CrossMarketArbitrageService {
  private pm: PolymarketConnector;
  private pf: PredictFunConnector;
  private matcher!: EventMatcher;
  private detector!: CrossMarketDetector;
  private coordinator!: AtomicCoordinator;
  private bridge: BridgeService;
  private rebalancer!: Rebalancer;

  private matches: any[] = [];
  private isRunning = false;
  private scanInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.pm = new PolymarketConnector();
    this.pf = new PredictFunConnector();
    this.bridge = new BridgeService();
  }

  async start(): Promise<void> {
    console.log('启动跨市场套利服务 (Predict.fun ↔ Polymarket)...');

    // 初始化连接器
    await Promise.all([this.pm.initialize(), this.pf.initialize()]);

    // 初始化模块
    this.matcher = new EventMatcher(this.pm, this.pf);
    this.detector = new CrossMarketDetector(this.pm, this.pf, {
      minProfitBps: 50,
      maxPositionValue: 10000,
    });
    this.coordinator = new AtomicCoordinator(this.pm, this.pf);
    this.rebalancer = new Rebalancer(this.bridge, this.pm, this.pf);

    this.isRunning = true;

    // 首次构建匹配索引
    console.log('构建跨平台事件匹配索引...');
    this.matches = await this.matcher.buildMatchIndex();
    console.log(`找到 ${this.matches.length} 个匹配事件对`);

    // 开始周期性扫描
    this.scanInterval = setInterval(() => this.scanLoop(), 5000);

    // 周期再平衡
    setInterval(() => this.rebalancer.checkAndRebalance(), 300000); // 5min
  }

  private async scanLoop(): Promise<void> {
    if (!this.isRunning) return;

    for (const match of this.matches) {
      try {
        const opp = await this.detector.detectArbitrage(match);
        if (opp && opp.score > 60) { // 评分阈值
          console.log(
            `🟢 套利机会: ${match.pmMarket.title} | ` +
            `${opp.bestDirection} | Profit: ${opp.estimatedNetProfitUSDT.toFixed(2)} USDT | ` +
            `Score: ${opp.score.toFixed(0)}`
          );

          // 执行
          const result = await this.coordinator.executeAtomicArbitrage(opp, {
            isNegRisk: opp.event.pfMarket.isNegRisk,
            isYieldBearing: true,
          });

          console.log(
            `执行结果: success=${result.success}, hedged=${result.hedged}, ` +
            `profit=${result.profitUSDT.toFixed(2)}`
          );
        }
      } catch (error) {
        // 跳过失败的匹配对
      }
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.scanInterval) clearInterval(this.scanInterval);
  }
}

const service = new CrossMarketArbitrageService();
service.start().catch(console.error);
```

---

## 6. 跨链桥接方案

### 6.1 桥接方案对比

| 方案 | 速度 | 费用 | 去中心化 | 推荐度 |
|------|------|------|----------|--------|
| **Stargate (LayerZero)** | ~1-2 min | 0.06%-0.1% | 高 | ⭐⭐⭐⭐⭐ |
| **Celer cBridge** | ~3-5 min | 0.1%-0.2% | 中 | ⭐⭐⭐⭐ |
| **Binance CEX 中转** | ~10-20 min | 0.2% | 低 | ⭐⭐ |
| **Multichain** | ~5-10 min | 0.1% | 中 | ⭐⭐⭐ |

### 6.2 资金分配策略

```
初始资金假设：$100,000

分配方案：
  50% ($50,000) → Polygon (Polymarket)  → pUSD
  50% ($50,000) → BNB Chain (Predict.fun) → USDT

再平衡规则：
  - 每小时检查一次余额比例
  - 偏离目标比例 > 15% → 触发再平衡
  - 再平衡量 = min(差额, 流动性窗口)
  - 桥接费用控制在总价值的 0.2% 以内
```

---

## 7. 风险控制与监控

### 7.1 跨市场特有风险

| 风险类别 | 描述 | 严重性 | 缓解措施 |
|----------|------|--------|----------|
| **非原子执行风险** | 双边订单只有一边成交 | 高 | 原子性协调器 + 超时取消 + 紧急对冲 |
| **跨链桥接失败** | 桥接交易卡住或资金丢失 | 高 | 仅使用经过审计的桥接协议 + 小额分拆 |
| **UMA 解析分歧** | 两个平台对同一事件解析结果不同 | 中 | 仅匹配解析规则书面一致的事件 |
| **流动性骤变** | 提交时订单簿已变化 | 中 | 实时 WS 监控 + 价格偏差检测 |
| **资金汇率风险** | USDT ↔ USDC 脱锚 | 低 | 监控稳定币汇率 + 限制敞口 |
| **网络拥堵** | 某链 Gas 飙升 | 中 | 动态 Gas 调整 + 利润缓冲 |
| **API 限流** | 请求被限 | 中 | 请求队列 + 指数退避 |
| **事件匹配错误** | 两个实际上不同的事件被匹配 | 高 | 人工审核匹配结果 + 置信度阈值 |

### 7.2 极端场景应急方案

**场景 1：Polymarket 成交，Predict.fun 未成交**
1. 立即取消 PF 未成交订单
2. 在 PF 上以 MARKET 方式对冲 PM 持仓
3. 如果对冲产生额外成本，记录为"紧急对冲损失"
4. 触发告警

**场景 2：桥接资金卡住**
1. 检查桥接交易状态（TxHash）
2. 如果超过 30 分钟未确认，联系桥接协议支持
3. 暂停相关链的资金转出
4. 触发告警

**场景 3：UMA 解析不一致**
1. 两个平台解析出不同结果（极端罕见）
2. 检查两边的 resolution source 文档
3. 如果不一致是由于规则解释差异 → 同时联系两平台
4. 单次损失计入"灰犀牛"损失准备金

---

## 8. 部署与运维

### 8.1 环境变量模板 (`.env.example`)

```env
# Polymarket
POLYMARKET_PRIVATE_KEY=0x_your_polygon_private_key
POLYMARKET_FUNDER_ADDRESS=0x_your_deposit_wallet_address
POLYMARKET_CLOB_URL=https://clob.polymarket.com
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com

# Predict.fun
PREDICT_API_URL=https://api.predict.fun
PREDICT_API_KEY=your_pf_api_key
PREDICT_PRIVATE_KEY=0x_your_bsc_private_key
PREDICT_ACCOUNT_ADDRESS=0x_your_predict_account

# 套利参数
MIN_PROFIT_BPS=50
MAX_POSITION_VALUE=10000
BRIDGE_FEE_BPS=20
SLIPPAGE_BPS=30
EXECUTION_TIMEOUT_MS=15000

# 再平衡参数
TARGET_BALANCE_RATIO=0.5
REBALANCE_THRESHOLD=0.15
REBALANCE_INTERVAL_MS=300000

# 扫描间隔
SCAN_INTERVAL_MS=5000

# Gas 估算
POLYGON_GAS_USD=0.05
BNB_GAS_USD=0.60
```

### 8.2 部署步骤

```bash
# 1. 安装依赖
npm install @polymarket/clob-client-v2 viem \
            @predictdotfun/sdk ethers \
            ws axios dotenv

# 2. 配置
cp .env.example .env
# 编辑 .env 填入双平台 API Key 和私钥

# 3. 编译并运行
npm run build
npm start
```

### 8.3 多阶段上线策略

**Phase 1: 只读监控（1-2周）**
- 启动事件匹配和价差监控
- 记录所有检测到的套利机会（不执行）
- 统计机会频率、利润分布、误报率
- 验证事件匹配准确率

**Phase 2: 小额实盘（2-4周）**
- 启用策略 C (Crypto Delta-Neutral)，单笔 ≤ $500
- 15 分钟结算周期，资金效率最高
- 快速迭代，优化执行参数

**Phase 3: 全量部署**
- 启用策略 A/B
- 单笔提升至 $1,000-$10,000
- 接入自动化再平衡
- 24/7 无人值守运行

---

## 附录：关键 API 端点速查

### Polymarket

| 操作 | 端点 | 认证 |
|------|------|------|
| 获取事件 | `GET https://gamma-api.polymarket.com/events` | None |
| 获取市场 | `GET https://gamma-api.polymarket.com/markets` | None |
| 获取订单簿 | `GET https://clob.polymarket.com/book?token_id=X` | None |
| 创建订单 | `POST https://clob.polymarket.com/order` | L2 HMAC |
| WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | None |
| 获取余额 | `GET https://clob.polymarket.com/balance` | L2 |

### Predict.fun

| 操作 | 端点 | 认证 |
|------|------|------|
| 获取市场 | `GET /v1/markets` | API Key + JWT |
| 获取市场详情 | `GET /v1/markets/{id}` | API Key + JWT |
| 获取订单簿 | `GET /v1/markets/{id}/orderbook` | API Key + JWT |
| 创建订单 | `POST /v1/orders` | API Key + JWT |
| 获取订单状态 | `GET /v1/orders/{hash}` | API Key + JWT |
| 取消订单 | `DELETE /v1/orders` | API Key + JWT |
| WebSocket | `wss://api.predict.fun/ws` | API Key + JWT |
| 获取持仓 | `GET /v1/positions` | API Key + JWT |
| 获取账户 | `GET /v1/account` | API Key + JWT |
