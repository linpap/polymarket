/**
 * Signal Extractors — convert raw market data into Bayesian likelihoods.
 *
 * Each signal returns null when it has nothing meaningful to say.
 * Signals only fire when they have genuine information — not noise.
 */

import { createLogger } from "../logger";
import {
  NVIDIA_API_KEY, NVIDIA_ENDPOINT, NVIDIA_MODEL,
  OPENROUTER_API_KEY, OPENROUTER_ENDPOINT, OPENROUTER_MODELS,
  BAYESIAN,
} from "../config";
import { Market, MarketBooks, CoinbasePrice, SignalLikelihood } from "../types";

const log = createLogger("signals");

// ── Standard normal CDF (Abramowitz & Stegun) ──

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

// ── Signal 1: Price Momentum (crypto up/down) ──

/**
 * Detects when crypto price has moved significantly relative to the strike.
 * Requires a 1.5-sigma move to fire (avoids noise).
 * Momentum persistence (1m + 5m same direction) boosts the signal.
 */
export function priceMomentumSignal(
  market: Market,
  coinbase: CoinbasePrice | null,
): SignalLikelihood | null {
  if (!coinbase || !market.strikePrice || market.category !== "crypto-updown") return null;

  const hoursToExpiry = (market.windowEnd - Date.now()) / (1000 * 3600);
  if (hoursToExpiry <= 0) return null;

  const annualVol = coinbase.realizedVol;
  const minuteVol = annualVol / Math.sqrt(365.25 * 24 * 60);

  if (minuteVol <= 0) return null;

  // Require minimum 1.5-sigma 1-min move to fire
  const magnitude = Math.abs(coinbase.change1m);
  const numSigmas = magnitude / minuteVol;
  if (numSigmas < BAYESIAN.momentumMinSigma) return null;

  // Momentum persistence: 1m and 5m in same direction = higher conviction
  const sameDirection = (coinbase.change1m > 0 && coinbase.change5m > 0) ||
    (coinbase.change1m < 0 && coinbase.change5m < 0);

  // Direction of move relative to strike
  const priceAboveStrike = coinbase.price > market.strikePrice;
  const movingToward = (priceAboveStrike && coinbase.change1m > 0) ||
    (!priceAboveStrike && coinbase.change1m < 0);

  // Base likelihood from sigma strength
  let likYes: number;
  if (priceAboveStrike) {
    likYes = Math.min(0.90, 0.55 + numSigmas * 0.06);
  } else {
    likYes = Math.max(0.10, 0.45 - numSigmas * 0.06);
  }

  // Boost/penalize based on momentum persistence
  if (sameDirection && movingToward) {
    likYes = priceAboveStrike
      ? Math.min(0.92, likYes + 0.08)
      : Math.max(0.08, likYes - 0.08);
  }

  // Time decay: closer to expiry = signal is more decisive
  const timeDecay = Math.max(0, 1 - hoursToExpiry / 0.5); // peaks within 30min
  if (timeDecay > 0) {
    const boost = timeDecay * 0.05;
    likYes = priceAboveStrike
      ? Math.min(0.95, likYes + boost)
      : Math.max(0.05, likYes - boost);
  }

  const likNo = 1 - likYes;

  return {
    name: "price-momentum",
    likelihoodYes: Math.max(0.05, likYes),
    likelihoodNo: Math.max(0.05, likNo),
    weight: BAYESIAN.signalWeights.priceMomentum,
  };
}

// ── Signal 2: Orderbook Imbalance ──

/**
 * Fires when bid/ask depth ratio is strongly skewed (>= 15% net imbalance).
 * Heavy bids on one side = informed accumulation.
 */
export function orderbookImbalanceSignal(
  books: MarketBooks,
): SignalLikelihood | null {
  const yesTotalDepth = books.yes.bidDepthUsd + books.yes.askDepthUsd;
  const noTotalDepth = books.no.bidDepthUsd + books.no.askDepthUsd;

  if (yesTotalDepth < 100 && noTotalDepth < 100) return null;

  const yesBidRatio = yesTotalDepth > 0 ? books.yes.bidDepthUsd / yesTotalDepth : 0.5;
  const noBidRatio = noTotalDepth > 0 ? books.no.bidDepthUsd / noTotalDepth : 0.5;

  // Net imbalance: positive = YES-bullish
  const netImbalance = yesBidRatio - noBidRatio;

  // Require minimum threshold to fire — avoid noise
  if (Math.abs(netImbalance) < BAYESIAN.imbalanceMinNet) return null;

  // Strength scales with how far past threshold
  const strength = (Math.abs(netImbalance) - BAYESIAN.imbalanceMinNet) /
    (1 - BAYESIAN.imbalanceMinNet);

  const likYes = netImbalance > 0
    ? Math.min(0.85, 0.55 + strength * 0.30)
    : Math.max(0.15, 0.45 - strength * 0.30);
  const likNo = 1 - likYes;

  return {
    name: "orderbook-imbalance",
    likelihoodYes: Math.max(0.10, likYes),
    likelihoodNo: Math.max(0.10, likNo),
    weight: BAYESIAN.signalWeights.orderbookImbalance,
  };
}

// ── Signal 3: External Price / Black-Scholes (crypto up/down) ──

/**
 * Black-Scholes P(above strike) using realized vol.
 * Only fires when BS probability diverges from market midpoint by >= 3%.
 * This is the strongest signal for crypto markets.
 */
export function externalPriceSignal(
  market: Market,
  coinbase: CoinbasePrice | null,
): SignalLikelihood | null {
  if (!coinbase || !market.strikePrice || market.category !== "crypto-updown") return null;

  const hoursToExpiry = (market.windowEnd - Date.now()) / (1000 * 3600);
  if (hoursToExpiry <= 0) return null;

  const annualVol = coinbase.realizedVol;
  const hoursPerYear = 365.25 * 24;
  const sigma = annualVol * Math.sqrt(hoursToExpiry / hoursPerYear);

  let probAbove: number;
  if (sigma <= 0) {
    probAbove = coinbase.price >= market.strikePrice ? 0.99 : 0.01;
  } else {
    const d2 = (Math.log(coinbase.price / market.strikePrice) - 0.5 * sigma * sigma) / sigma;
    probAbove = normalCDF(d2);
  }

  probAbove = Math.max(0.02, Math.min(0.98, probAbove));

  // Scale weight by divergence from market — always fire, but weak when close
  const marketMid = market.currentYes;
  const divergence = Math.abs(probAbove - marketMid);
  const weightScale = Math.min(1.0, divergence / 0.05); // full weight at 5% divergence
  const weight = BAYESIAN.signalWeights.externalPrice * Math.max(0.3, weightScale);

  return {
    name: "external-price",
    likelihoodYes: probAbove,
    likelihoodNo: 1 - probAbove,
    weight,
  };
}

// ── Signal 4: LLM Prior (general markets) ──

const llmCache: Map<string, { estimate: number; confidence: number; reasoning: string; timestamp: number }> = new Map();

interface LLMEstimate {
  probability: number;
  confidence: number;
  reasoning: string;
}

async function callNvidia(prompt: string): Promise<LLMEstimate | null> {
  if (!NVIDIA_API_KEY) return null;

  try {
    const resp = await fetch(NVIDIA_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as any;
    const content = data.choices?.[0]?.message?.content || "";
    return parseEstimate(content);
  } catch {
    return null;
  }
}

async function callOpenRouter(prompt: string): Promise<LLMEstimate | null> {
  if (!OPENROUTER_API_KEY) return null;

  for (const model of OPENROUTER_MODELS) {
    try {
      const resp = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://github.com/polymarket-agent",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 300,
        }),
      });

      if (!resp.ok) continue;

      const data = await resp.json() as any;
      const content = data.choices?.[0]?.message?.content || "";
      const estimate = parseEstimate(content);
      if (estimate) return estimate;
    } catch {
      continue;
    }
  }

  return null;
}

function parseEstimate(content: string): LLMEstimate | null {
  try {
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const probability = parseFloat(parsed.probability);
    const confidence = parseFloat(parsed.confidence) || 0.5;
    const reasoning = String(parsed.reasoning || "").slice(0, 200);

    if (isNaN(probability) || probability < 0 || probability > 1) return null;
    return { probability, confidence, reasoning };
  } catch {
    return null;
  }
}

function buildPrompt(market: Market): string {
  const closeDate = new Date(market.windowEnd).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  return `You are an independent prediction analyst. Your job is to estimate probabilities from first principles — do NOT simply agree with the market price.

Question: "${market.question}"
Category: ${market.category}
Resolution date: ${closeDate}

IMPORTANT: Form your OWN estimate FIRST based on:
- Historical base rates for similar events
- Current geopolitical/economic context (today is March 2026)
- Logical reasoning about what needs to happen for YES to resolve
- Time pressure: how much could change before ${closeDate}?

Do NOT anchor to any price. Think step by step, then give your independent probability.

Respond with ONLY a JSON object:
{"probability": 0.XX, "confidence": 0.XX, "reasoning": "your step-by-step reasoning in 2-3 sentences"}

probability = your estimated chance this resolves YES (0.0 to 1.0)
confidence = how confident you are (0.5 = coin flip, 0.9 = very sure)`;
}

export async function llmPriorSignal(
  market: Market,
): Promise<SignalLikelihood | null> {
  if (market.category === "crypto-updown") return null;

  // Check cache/cooldown
  const cached = llmCache.get(market.marketId);
  if (cached && Date.now() - cached.timestamp < BAYESIAN.llmCooldownMs) {
    return {
      name: "llm-prior",
      likelihoodYes: Math.max(0.05, cached.estimate),
      likelihoodNo: Math.max(0.05, 1 - cached.estimate),
      weight: BAYESIAN.signalWeights.llmPrior,
    };
  }

  const prompt = buildPrompt(market);

  let estimate = await callNvidia(prompt);
  if (!estimate) {
    estimate = await callOpenRouter(prompt);
  }

  if (!estimate || estimate.confidence < 0.50) return null;

  llmCache.set(market.marketId, {
    estimate: estimate.probability,
    confidence: estimate.confidence,
    reasoning: estimate.reasoning,
    timestamp: Date.now(),
  });

  log.debug("LLM signal", {
    q: market.question.slice(0, 50),
    prob: estimate.probability.toFixed(3),
    conf: estimate.confidence.toFixed(2),
  });

  return {
    name: "llm-prior",
    likelihoodYes: Math.max(0.05, estimate.probability),
    likelihoodNo: Math.max(0.05, 1 - estimate.probability),
    weight: BAYESIAN.signalWeights.llmPrior,
  };
}

// ── Aggregator ──

/**
 * Extract all applicable signals for a market.
 * Returns only signals that have something meaningful to say.
 */
export async function extractSignals(
  market: Market,
  books: MarketBooks,
  coinbase: CoinbasePrice | null,
): Promise<SignalLikelihood[]> {
  const signals: SignalLikelihood[] = [];

  // Orderbook imbalance (all markets, requires strong imbalance)
  const obSignal = orderbookImbalanceSignal(books);
  if (obSignal) signals.push(obSignal);

  // Crypto-specific signals
  if (market.category === "crypto-updown") {
    const pmSignal = priceMomentumSignal(market, coinbase);
    if (pmSignal) signals.push(pmSignal);

    const epSignal = externalPriceSignal(market, coinbase);
    if (epSignal) signals.push(epSignal);
  }

  // General market LLM signal
  if (market.category !== "crypto-updown") {
    const llmSignal = await llmPriorSignal(market);
    if (llmSignal) signals.push(llmSignal);
  }

  return signals;
}
