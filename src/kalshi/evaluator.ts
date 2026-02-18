import { createLogger } from "../logger";
import { CATEGORY_MULTIPLIERS, KALSHI_TRADING } from "./config";
import { KalshiMarket, KalshiSignal, KalshiCategory } from "./types";
import { detectCategory } from "./scanner";
import { evaluateCryptoPrice } from "./strategies/crypto-price";
import { evaluateCrossArb } from "./strategies/cross-arb";
import { evaluateLLMFair } from "./strategies/llm-fair";

const log = createLogger("kalshi-eval");

// Track recently evaluated markets to avoid spam
const recentlyEvaluated = new Map<string, number>();
const EVAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown per market

// ─── Evaluate a single market across all strategies ───

export async function evaluateMarket(market: KalshiMarket): Promise<KalshiSignal | null> {
  // Cooldown check
  const lastEval = recentlyEvaluated.get(market.ticker);
  if (lastEval && Date.now() - lastEval < EVAL_COOLDOWN_MS) return null;
  recentlyEvaluated.set(market.ticker, Date.now());

  const category = detectCategory(market);
  const multiplier = CATEGORY_MULTIPLIERS[category] || 0.7;

  const signals: KalshiSignal[] = [];

  // Strategy 1: Crypto price (fast, no LLM)
  if (category === "crypto") {
    const signal = evaluateCryptoPrice(market);
    if (signal) signals.push(signal);
  }

  // Strategy 2: Cross-platform arb (fast, no LLM)
  const crossSignal = evaluateCrossArb(market);
  if (crossSignal) signals.push(crossSignal);

  // Strategy 3: LLM fair value (slow, for non-crypto)
  if (category !== "crypto" && signals.length === 0) {
    const llmSignal = await evaluateLLMFair(market);
    if (llmSignal) signals.push(llmSignal);
  }

  if (signals.length === 0) return null;

  // Rank signals by edge * confidence * category multiplier
  const ranked = signals
    .map((s) => ({
      signal: s,
      score: s.edge * s.confidence * multiplier,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  // Apply category multiplier to the signal
  best.signal.categoryMultiplier = multiplier;

  log.info("Best signal for market", {
    ticker: market.ticker,
    strategy: best.signal.strategy,
    side: best.signal.side,
    edge: (best.signal.edge * 100).toFixed(1) + "%",
    score: best.score.toFixed(4),
    category,
  });

  return best.signal;
}

// ─── Evaluate all markets, return ranked signals ───

export async function evaluateAllMarkets(markets: KalshiMarket[]): Promise<KalshiSignal[]> {
  const signals: KalshiSignal[] = [];

  for (const market of markets) {
    try {
      const signal = await evaluateMarket(market);
      if (signal) signals.push(signal);
    } catch (e) {
      log.error("Error evaluating market", {
        ticker: market.ticker,
        error: (e as Error).message,
      });
    }
  }

  // Sort by edge * confidence descending
  signals.sort((a, b) => (b.edge * b.confidence) - (a.edge * a.confidence));

  return signals;
}

// Clean up old cooldowns periodically
setInterval(() => {
  const cutoff = Date.now() - EVAL_COOLDOWN_MS;
  for (const [ticker, time] of recentlyEvaluated) {
    if (time < cutoff) recentlyEvaluated.delete(ticker);
  }
}, 60_000);
