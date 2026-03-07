// ── Market Data ──

export interface Market {
  marketId: string;
  conditionId: string;
  question: string;
  slug: string;
  category: MarketCategory;
  // Crypto-specific
  asset?: string;               // BTC, ETH, SOL
  direction?: "up" | "down";    // what YES means (crypto up/down)
  strikePrice?: number;
  // Timing
  windowStart: number;          // unix ms
  windowEnd: number;            // unix ms
  // Prices (from Gamma API)
  currentYes: number;           // 0-1
  currentNo: number;            // 0-1
  // Token IDs for CLOB
  yesTokenId: string;
  noTokenId: string;
  liquidity: number;
  active: boolean;
}

export type MarketCategory = "crypto-updown" | "crypto-price" | "politics" | "economics" | "sports" | "other";

// ── Price Feed ──

export interface PriceTick {
  price: number;
  timestamp: number;
}

export interface CoinbasePrice {
  symbol: string;              // btcusdt
  price: number;
  timestamp: number;
  change1m: number;            // fractional (0.003 = 0.3%)
  change5m: number;
  momentum: "up" | "down" | "flat";
  realizedVol: number;         // annualized realized volatility from rolling window
}

// ── Order Book ──

export interface OrderBookLevel {
  price: number;
  size: number;                // shares available
}

export interface OrderBook {
  tokenId: string;
  bids: OrderBookLevel[];      // sorted desc by price
  asks: OrderBookLevel[];      // sorted asc by price
  bestBid: number;
  bestAsk: number;
  midpoint: number;
  spread: number;
  bidDepthUsd: number;         // total USD on bid side (top 10)
  askDepthUsd: number;         // total USD on ask side (top 10)
  timestamp: number;
}

export interface MarketBooks {
  yes: OrderBook;
  no: OrderBook;
  combinedAsk: number;         // YES bestAsk + NO bestAsk
}

// ── Slippage ──

export interface SlippageEstimate {
  vwap: number;                // volume-weighted average price for the order
  slippagePct: number;         // (vwap - bestAsk) / bestAsk
  fillableShares: number;      // how many shares can be filled in top-N levels
  fillableUsd: number;         // total USD available in book
  feasible: boolean;           // can the order be fully filled?
}

// ── Bayesian Engine ──

export interface SignalLikelihood {
  name: string;                // signal identifier
  likelihoodYes: number;       // P(data | YES)
  likelihoodNo: number;        // P(data | NO)
  weight: number;              // signal weight in update
}

// ── Signals ──

export type StrategyType = "bayesian-lmsr" | "complete-set";

export interface Signal {
  strategy: StrategyType;
  market: Market;
  action: "buy-yes" | "buy-no" | "buy-both";
  edge: number;                // expected profit margin (0-1)
  confidence: number;          // 0-1
  fairValue?: number;          // estimated probability for YES
  reasoning: string;
  // Populated by sizer
  size?: number;               // USD to spend
  shares?: number;
  slippage?: SlippageEstimate;
}

// ── Paper Trading ──

export interface PaperTrade {
  id: string;
  timestamp: number;
  market: {
    marketId: string;
    question: string;
    category: MarketCategory;
    asset?: string;
    strikePrice?: number;
    windowEnd: number;
  };
  strategy: StrategyType | string; // string for legacy strategy labels
  side: "YES" | "NO" | "BOTH";
  entryPriceYes: number;
  entryPriceNo: number;
  vwapEntry: number;           // actual fill price (VWAP)
  size: number;                // USD spent
  shares: number;
  coinbasePriceAtEntry: number;
  edge: number;
  confidence: number;
  reasoning: string;
  // Resolution
  resolved: boolean;
  outcome: "YES" | "NO" | null;
  coinbasePriceAtExpiry: number | null;
  pnl: number | null;
}

export interface BotStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  byStrategy: Record<string, { trades: number; wins: number; pnl: number }>;
  opportunitiesSeen: number;
  opportunitiesSkipped: number;
}

export interface BotState {
  startedAt: number;
  bankroll: number;
  initialBankroll: number;
  trades: PaperTrade[];
  openPositions: PaperTrade[];
  stats: BotStats;
  lastStatusLog: number;
}
