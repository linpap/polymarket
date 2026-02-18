import "dotenv/config";
import path from "path";

// ─── Env vars ───

export const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// ─── Binance WebSocket ───

export const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws";
export const TRACKED_SYMBOLS = ["btcusdt", "ethusdt", "solusdt"] as const;
export type TrackedSymbol = (typeof TRACKED_SYMBOLS)[number];

// Maps Polymarket asset names to Binance symbols
export const ASSET_TO_SYMBOL: Record<string, TrackedSymbol> = {
  BTC: "btcusdt",
  Bitcoin: "btcusdt",
  ETH: "ethusdt",
  Ethereum: "ethusdt",
  SOL: "solusdt",
  Solana: "solusdt",
};

// ─── Polymarket / Gamma ───

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";
export const SCANNER_POLL_MS = 10_000; // 10 seconds

// ─── Kalshi ───

export const KALSHI_API = "https://trading-api.kalshi.com/trade-api/v2";
export const KALSHI_POLL_MS = 30_000; // 30 seconds

// ─── NVIDIA GLM ───

export const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
export const NVIDIA_MODEL = "nvidia/llama-3.3-nemotron-70b-instruct";

// ─── Trading params ───

export const UPDOWN_TRADING = {
  initialBankroll: 10_000,       // $10,000 paper
  maxPositionPct: 0.05,          // 5% per trade ($500)
  maxPositionUsd: 500,           // Hard cap
  latencyMinEdge: 0.01,          // 1% minimum edge for latency arb
  completeSetThreshold: 0.97,    // YES + NO < $0.97 for complete-set arb
  momentumThreshold: 0.0003,     // 0.03% move = significant enough for paper trading
  latencyTimeRemaining: 600,     // <10 min remaining for latency arb (seconds)
  glmConfidenceLow: 0.50,        // Below this = skip
  glmConfidenceHigh: 0.65,       // Above this = trade without GLM
  latencyConfidentPrice: 0.90,   // YES price threshold for high-confidence latency arb
  priceWindowSeconds: 300,       // 5-minute rolling window
  momentumWindowSeconds: 120,    // 2-minute momentum check
  statusLogIntervalMs: 30_000,   // Log status every 30s
} as const;

// ─── State file paths ───

export const STATE_DIR = path.join(__dirname, "..", "..", "state");
export const UPDOWN_STATE_FILE = path.join(STATE_DIR, "updown-trades.json");
