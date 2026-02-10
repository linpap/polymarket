// ─── Market Data ───

export interface GammaMarket {
  id: string;
  question: string;
  description: string;
  conditionId: string;
  slug: string;
  endDate: string;
  liquidity: string;
  volume: string;
  outcomes: string[];       // e.g. ["Yes", "No"]
  outcomePrices: string[];  // e.g. ["0.65", "0.35"]
  clobTokenIds: string[];   // [yesTokenId, noTokenId]
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  tags?: { id: string; label: string; slug: string }[];
}

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  markets: GammaMarket[];
  endDate: string;
  active: boolean;
  closed: boolean;
}

// ─── Estimation ───

export interface Stage1Estimate {
  marketId: string;
  question: string;
  fairYes: number;        // 0-1 probability
  currentYes: number;     // current market price
  potentialEdge: number;  // abs(fair - current)
}

export interface Stage2Estimate {
  marketId: string;
  question: string;
  fairYes: number;
  confidence: number;     // 0-1, how sure the model is
  reasoning: string;
  keyFactors: string[];
}

// ─── Analysis ───

export interface Signal {
  market: GammaMarket;
  fairYes: number;
  confidence: number;
  reasoning: string;
  edge: number;           // signed: positive = buy YES, negative = buy NO
  side: "YES" | "NO";
  marketPrice: number;    // price we'd pay
  tokenId: string;        // which token to buy
}

// ─── Sizing ───

export interface SizedPosition {
  signal: Signal;
  kellyFraction: number;  // raw kelly %
  positionSize: number;   // USD amount to risk
  shares: number;         // positionSize / marketPrice
}

// ─── Execution ───

export interface TradeResult {
  success: boolean;
  orderId?: string;
  signal: Signal;
  size: number;
  price: number;
  side: "YES" | "NO";
  timestamp: number;
  error?: string;
}

// ─── State / Tracking ───

export interface OpenPosition {
  marketId: string;
  question: string;
  conditionId: string;
  tokenId: string;
  side: "YES" | "NO";
  entryPrice: number;
  shares: number;
  costBasis: number;      // total USD spent
  timestamp: number;
  orderId: string;
}

export interface ClosedPosition {
  marketId: string;
  question: string;
  side: "YES" | "NO";
  entryPrice: number;
  exitPrice: number;      // 1 if resolved in our favor, 0 if against, or sell price
  shares: number;
  costBasis: number;
  proceeds: number;
  pnl: number;
  resolvedAt: number;
}

export interface AgentState {
  startedAt: number;
  lastCycleAt: number;
  cycleCount: number;
  initialBankroll: number;
  currentBalance: number;      // USDC on-chain
  openPositions: OpenPosition[];
  closedPositions: ClosedPosition[];
  totalPnl: number;
  totalApiCost: number;
  dailyApiCost: number;
  dailyApiCostResetAt: number;
  alive: boolean;
}

// ─── API Credentials ───

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}
