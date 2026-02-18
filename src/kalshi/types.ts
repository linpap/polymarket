// ─── Kalshi Market Data ───

export interface KalshiMarket {
  ticker: string;           // e.g. "KXBTC-26FEB21-B100000"
  event_ticker: string;     // parent event e.g. "KXBTC-26FEB21"
  series_ticker: string;    // series e.g. "KXBTC"
  title: string;
  subtitle: string;
  category: string;         // "Crypto", "Economics", "Politics", "Weather"
  yes_ask: number;          // 0-1 (converted from cents)
  no_ask: number;
  yes_bid: number;
  no_bid: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  close_time: string;       // ISO timestamp
  result: string;           // "", "yes", "no" — used for resolution
  status: string;           // "open", "closed", "settled"
}

export type KalshiCategory = "crypto" | "economics" | "politics" | "weather" | "other";

// ─── Trading Signals ───

export type KalshiStrategy = "crypto-price" | "cross-arb" | "llm-fair";

export interface KalshiSignal {
  strategy: KalshiStrategy;
  market: KalshiMarket;
  side: "yes" | "no";
  fairValue: number;        // our estimated probability 0-1
  marketPrice: number;      // what we'd pay (ask price)
  edge: number;             // fairValue - marketPrice
  confidence: number;       // 0-1 how sure we are of fairValue
  reasoning: string;
  categoryMultiplier: number;
}

// ─── Paper Trading ───

export interface KalshiTrade {
  id: string;
  timestamp: number;
  market: {
    ticker: string;
    title: string;
    category: KalshiCategory;
    close_time: string;
  };
  strategy: KalshiStrategy;
  side: "yes" | "no";
  entryPrice: number;       // what we paid (0-1)
  size: number;             // USD spent
  contracts: number;        // size / entryPrice
  fairValue: number;
  edge: number;
  confidence: number;
  reasoning: string;
  // Resolution
  resolved: boolean;
  result: "yes" | "no" | null;
  pnl: number | null;
}

export interface KalshiStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  byStrategy: Record<KalshiStrategy, {
    trades: number;
    wins: number;
    pnl: number;
  }>;
  byCategory: Record<string, {
    trades: number;
    wins: number;
    pnl: number;
  }>;
  marketsScanned: number;
  signalsGenerated: number;
}

export interface KalshiState {
  startedAt: number;
  bankroll: number;
  initialBankroll: number;
  trades: KalshiTrade[];
  openPositions: KalshiTrade[];
  stats: KalshiStats;
  lastScanTime: number;
}

// ─── Kalshi API Response Types ───

export interface KalshiMarketsResponse {
  markets: KalshiRawMarket[];
  cursor: string;
}

export interface KalshiRawMarket {
  ticker: string;
  event_ticker: string;
  series_ticker: string;
  title: string;
  subtitle: string;
  category: string;
  yes_ask: number;          // in cents (1-99)
  no_ask: number;
  yes_bid: number;
  no_bid: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  close_time: string;
  result: string;
  status: string;
}
