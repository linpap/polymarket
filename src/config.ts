import "dotenv/config";
import path from "path";

// ── Env vars ──

export const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// ── Coinbase WebSocket ──

export const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";
export const COINBASE_PRODUCT_IDS = ["BTC-USD", "ETH-USD", "SOL-USD"];
export const TRACKED_SYMBOLS = ["btcusdt", "ethusdt", "solusdt"] as const;
export type TrackedSymbol = (typeof TRACKED_SYMBOLS)[number];

export const ASSET_TO_SYMBOL: Record<string, TrackedSymbol> = {
  BTC: "btcusdt",
  Bitcoin: "btcusdt",
  ETH: "ethusdt",
  Ethereum: "ethusdt",
  SOL: "solusdt",
  Solana: "solusdt",
};

// ── Polymarket APIs ──

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";
export const SCANNER_POLL_MS = 10_000;

// ── LLM endpoints ──

export const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
export const NVIDIA_MODEL = "meta/llama-3.3-70b-instruct";
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS = [
  "google/gemma-3-27b-it:free",
  "deepseek/deepseek-r1:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
];

// ── Trading parameters ──

export const TRADING = {
  initialBankroll: 10_000,

  // Position sizing
  maxPositionPct: 0.05,          // 5% bankroll per trade
  maxPositionUsd: 500,
  maxOpenPositions: 5,
  maxPositionsPerAsset: 1,
  kellyFraction: 0.20,          // conservative 20% Kelly

  // Slippage gates
  minBookDepthUsd: 500,         // top-5 book must have $500+
  maxSlippagePct: 0.03,         // 3% max slippage
  minEdgeAfterSlippage: 0.02,   // 2% net edge required
  maxPositionPctOfBook: 0.50,   // don't take >50% of visible depth

  // Volatility-fair (Black-Scholes)
  defaultAnnualVol: 0.80,       // fallback if no realized vol yet
  volWindowMinutes: 30,         // rolling window for realized vol
  volMinSamples: 60,            // need 60+ ticks before trusting realized vol

  // Latency strategy
  latencyMaxTimeRemaining: 1800, // 30 min
  latencyMinTimeRemaining: 10,   // 10s
  latencySigmaThreshold: 2.0,   // move must be 2-sigma to qualify

  // Orderbook imbalance
  imbalanceThreshold: 0.80,     // 80%+ on one side
  imbalanceMinEdge: 0.03,       // 3% edge required

  // Complete-set
  completeSetThreshold: 0.98,   // YES+NO < $0.98

  // LLM fair value
  llmMinConfidence: 0.50,
  llmMinEdge: 0.04,             // 4% edge

  // Price feed
  priceWindowSeconds: 300,      // 5-min rolling
  momentumThreshold: 0.0001,    // 0.01% = significant move for callbacks
  statusLogIntervalMs: 30_000,

  // General market scanning
  generalMarketPollMs: 120_000, // poll general markets every 2 min
  generalMinHoursToClose: 1,
  generalMaxDaysToClose: 365,
} as const;

// ── State paths ──

export const STATE_DIR = path.join(__dirname, "..", "state");
export const STATE_FILE = path.join(STATE_DIR, "trades.json");
