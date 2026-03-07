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

// ── Bayesian engine parameters ──

export const BAYESIAN = {
  // Minimum edge to trigger a trade
  minEdgeThreshold: 0.001,        // 0.1% (max volume mode)

  // Signal weights for Bayesian update
  signalWeights: {
    priceMomentum: 0.8,           // crypto momentum
    orderbookImbalance: 0.5,      // bid/ask depth ratio
    externalPrice: 1.2,           // Black-Scholes (strongest)
    llmPrior: 1.0,                // LLM estimate (general markets)
  },

  // Signal thresholds (signals return null below these)
  momentumMinSigma: 0.5,          // 0.5σ move (aggressive for volume)
  imbalanceMinNet: 0.05,          // 5% net imbalance (aggressive)
  externalPriceMinDivergence: 0.003, // 0.3% BS divergence (mostly unused — signal scales weight instead)

  // Adaptive Kelly fraction by time-to-expiry
  kellyByDuration: {
    under1h: 0.10,                // 10% Kelly
    hours1to6: 0.15,              // 15%
    hours6to24: 0.20,             // 20%
    days1to7: 0.25,               // 25%
    over7d: 0.20,                 // 20% (less certain over long horizons)
  },

  // LLM cooldown per market
  llmCooldownMs: 3 * 60 * 1000,  // 3 minutes (aggressive)

  // Belief update interval (don't re-evaluate faster than this)
  updateIntervalMs: 1_000,       // 1 second (very aggressive)
} as const;

// ── Trading parameters ──

export const TRADING = {
  initialBankroll: 1_000_000,

  // Position sizing (many small bets — fits orderbook depth)
  maxPositionPct: 0.002,         // 0.2% bankroll per trade = $2K max
  maxPositionUsd: 2_000,
  maxOpenPositions: 500,
  maxPositionsPerAsset: 20,

  // Slippage gates
  minBookDepthUsd: 50,           // top-5 book must have $50+ (relaxed for volume)
  maxSlippagePct: 0.25,          // 25% max slippage (paper trading, accept wide books)
  minEdgeAfterSlippage: -1,      // disabled for paper trading (accept slippage)
  maxPositionPctOfBook: 0.40,    // don't take >40% of visible depth

  // Complete-set arbitrage
  completeSetThreshold: 0.98,    // YES+NO < $0.98

  // Price feed
  priceWindowSeconds: 300,       // 5-min rolling
  momentumThreshold: 0.0001,     // 0.01% = significant move for callbacks
  statusLogIntervalMs: 30_000,

  // Volatility (used by coinbase feed)
  defaultAnnualVol: 0.80,
  volMinSamples: 60,

  // General market scanning
  generalMarketPollMs: 60_000,   // poll general markets every 1 min
  generalMinHoursToClose: 1,
  generalMaxDaysToClose: 2,      // 48 hours only
} as const;

// ── State paths ──

export const STATE_DIR = path.join(__dirname, "..", "state");
export const STATE_FILE = path.join(STATE_DIR, "trades.json");
