import "dotenv/config";
import path from "path";
import { KalshiCategory } from "./types";

// ─── Env vars ───

export const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// ─── Kalshi API ───

export const KALSHI_API = "https://trading-api.kalshi.com/trade-api/v2";
export const KALSHI_RATE_LIMIT_MS = 500; // 500ms between calls

// Series tickers to scan
export const SERIES_TICKERS = [
  "KXBTC",   // Bitcoin price
  "KXETH",   // Ethereum price
  "KXFED",   // Fed rate decisions
  "KXCPI",   // CPI data
  "KXGDP",   // GDP
  "KXJOBS",  // Jobs report
  "KXINX",   // S&P 500 range
] as const;

// ─── Binance WebSocket (reused from updown) ───

export const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws";
export const TRACKED_SYMBOLS = ["btcusdt", "ethusdt"] as const;
export type TrackedSymbol = (typeof TRACKED_SYMBOLS)[number];

export const ASSET_TO_SYMBOL: Record<string, TrackedSymbol> = {
  BTC: "btcusdt",
  Bitcoin: "btcusdt",
  ETH: "ethusdt",
  Ethereum: "ethusdt",
};

// ─── NVIDIA GLM ───

export const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
export const NVIDIA_MODEL = "nvidia/llama-3.3-nemotron-70b-instruct";

// ─── OpenRouter (fallback) ───

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS = [
  "google/gemma-3-27b-it:free",
  "deepseek/deepseek-r1-0528:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
] as const;

// ─── Trading params ───

export const KALSHI_TRADING = {
  initialBankroll: 10_000,
  maxPositionPct: 0.03,        // 3% per trade ($300)
  maxPositionUsd: 300,
  kellyFraction: 0.20,         // 20% Kelly (conservative)

  // Market filters
  minVolume24h: 10,
  maxSpread: 0.15,             // 15% max bid-ask spread
  minTimeToClose: 60 * 60,     // 1 hour minimum
  maxTimeToClose: 7 * 24 * 60 * 60, // 7 days maximum

  // Strategy-specific minimum edges
  cryptoPriceMinEdge: 0.03,    // 3%
  crossArbMinEdge: 0.05,       // 5%
  llmFairMinEdge: 0.08,        // 8% (higher since LLM is less reliable)

  // LLM confidence thresholds
  llmMinConfidence: 0.60,      // reject below 60%

  // Resolution
  resolutionGraceMinutes: 5,   // wait 5min after close for result

  // Scan interval
  scanIntervalMs: 30_000,      // every 30s
  statusLogIntervalMs: 60_000, // status every 60s
} as const;

// ─── Category multipliers ───
// Higher = more willing to trade (effective edge threshold is lower)

export const CATEGORY_MULTIPLIERS: Record<KalshiCategory, number> = {
  crypto: 1.2,
  economics: 1.0,
  politics: 0.9,
  weather: 0.5,
  other: 0.7,
};

// ─── State file paths ───

export const STATE_DIR = path.join(__dirname, "..", "..", "state");
export const KALSHI_STATE_FILE = path.join(STATE_DIR, "kalshi-trades.json");
