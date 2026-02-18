// ─── Market Data ───

export interface UpDownMarket {
  marketId: string;
  conditionId: string;
  question: string;
  slug: string;
  asset: string;              // BTC, ETH, SOL
  direction: "up" | "down";   // what YES means
  strikePrice: number;         // price threshold
  windowStart: number;         // unix ms
  windowEnd: number;           // unix ms
  currentYes: number;          // 0-1
  currentNo: number;           // 0-1
  yesTokenId: string;
  noTokenId: string;
  liquidity: number;
  active: boolean;
}

// ─── Binance Price ───

export interface BinancePrice {
  symbol: string;              // btcusdt
  price: number;               // current price in USDT
  timestamp: number;           // unix ms
  change1m: number;            // % change in last 1 min
  change5m: number;            // % change in last 5 min
  momentum: "up" | "down" | "flat";
}

export interface PriceTick {
  price: number;
  timestamp: number;
}

// ─── Arbitrage Signals ───

export type SignalType = "latency" | "complete-set" | "cross-platform";

export interface ArbitrageSignal {
  type: SignalType;
  market: UpDownMarket;
  edge: number;                // expected profit margin (0-1)
  confidence: number;          // 0-1
  action: "buy-yes" | "buy-no" | "buy-both";
  reasoning: string;
  size?: number;               // USD amount (set by paper engine)
  binancePrice?: number;       // Binance price at signal time
  glmConfirmed?: boolean;      // whether GLM was consulted
}

// ─── Paper Trading ───

export interface PaperTrade {
  id: string;
  timestamp: number;
  market: {
    marketId: string;
    question: string;
    asset: string;
    strikePrice: number;
    windowEnd: number;
  };
  strategy: SignalType;
  side: "YES" | "NO" | "BOTH";
  entryPriceYes: number;
  entryPriceNo: number;
  size: number;                // USD spent
  shares: number;              // shares purchased
  binancePriceAtEntry: number;
  edge: number;
  confidence: number;
  reasoning: string;
  // Resolution
  resolved: boolean;
  outcome: "YES" | "NO" | null;
  binancePriceAtExpiry: number | null;
  pnl: number | null;
}

export interface UpDownStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  byStrategy: Record<SignalType, {
    trades: number;
    wins: number;
    pnl: number;
  }>;
  opportunitiesSeen: number;
  opportunitiesSkipped: number;
}

export interface UpDownState {
  startedAt: number;
  bankroll: number;
  initialBankroll: number;
  trades: PaperTrade[];
  openPositions: PaperTrade[];
  stats: UpDownStats;
  lastStatusLog: number;
}

// ─── Kalshi ───

export interface KalshiMarket {
  ticker: string;
  title: string;
  category: string;
  yes_ask: number;
  no_ask: number;
  yes_bid: number;
  no_bid: number;
  close_time: string;
  status: string;
}

export interface CrossPlatformOpp {
  polyMarket: UpDownMarket;
  kalshiMarket: KalshiMarket;
  polyYes: number;
  kalshiYes: number;
  spread: number;
  direction: string;
}

// ─── Order Book ───

export interface OrderBookSummary {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  midpoint: number;
  spread: number;
}

export interface MarketPrices {
  yesBook: OrderBookSummary;
  noBook: OrderBookSummary;
  combinedAsk: number; // YES ask + NO ask
}
