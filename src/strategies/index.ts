import { createLogger } from "../logger";
import { ASSET_TO_SYMBOL, TRADING, BAYESIAN } from "../config";
import { Market, MarketBooks, Signal } from "../types";
import { getMarketBooks } from "../markets/orderbook";
import { getPrice } from "../feeds/coinbase";
import { computePosterior, canEvaluate } from "../bayesian/engine";
import { extractSignals } from "../bayesian/signals";
import { detectInefficiency } from "../bayesian/lmsr";
import { computeSlippage } from "../markets/slippage";

const log = createLogger("strategy");

// ── Skip-reason tracking ──

const skipReasons: Record<string, number> = {};

function trackSkip(reason: string): null {
  skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  return null;
}

export function getSkipReasons(): Record<string, number> {
  return { ...skipReasons };
}

// ── Fallback books from scanner prices ──

function fallbackBooks(market: Market): MarketBooks {
  const yp = market.currentYes || 0.50;
  const np = market.currentNo || 0.50;
  const makeBook = (tokenId: string, price: number) => ({
    tokenId,
    bids: [{ price: Math.max(0.01, price - 0.01), size: 100 }],
    asks: [{ price: Math.min(0.99, price + 0.01), size: 100 }],
    bestBid: Math.max(0.01, price - 0.01),
    bestAsk: Math.min(0.99, price + 0.01),
    midpoint: price,
    spread: 0.02,
    bidDepthUsd: Math.max(0.01, price - 0.01) * 100,
    askDepthUsd: Math.min(0.99, price + 0.01) * 100,
    timestamp: Date.now(),
  });
  return {
    yes: makeBook(market.yesTokenId, yp),
    no: makeBook(market.noTokenId, np),
    combinedAsk: Math.min(0.99, yp + 0.01) + Math.min(0.99, np + 0.01),
  };
}

// LLM cooldown: don't re-evaluate general markets more than once every 10 min
const llmCooldowns: Map<string, number> = new Map();

// ── Complete-set arbitrage (risk-free, always check first) ──

function evaluateCompleteSet(market: Market, books: MarketBooks): Signal | null {
  const combined = books.combinedAsk;
  if (combined >= TRADING.completeSetThreshold) return null;

  const rawEdge = 1.0 - combined;

  // Check slippage on both sides
  const testSize = Math.min(500, rawEdge * 5000);
  const yesSlip = computeSlippage(books.yes, testSize / 2);
  const noSlip = computeSlippage(books.no, testSize / 2);

  const actualCostPerSet = yesSlip.vwap + noSlip.vwap;
  if (actualCostPerSet >= 1.0) return null;

  const netEdge = 1.0 - actualCostPerSet;
  if (netEdge < 0.005) return null; // need 0.5% after slippage

  log.info("COMPLETE-SET ARB", {
    id: market.marketId.slice(0, 12),
    yesAsk: books.yes.bestAsk.toFixed(3),
    noAsk: books.no.bestAsk.toFixed(3),
    combined: combined.toFixed(3),
    netEdge: (netEdge * 100).toFixed(1) + "%",
  });

  return {
    strategy: "complete-set",
    market,
    action: "buy-both",
    edge: netEdge,
    confidence: 0.99,
    reasoning: `Complete-set: YES=${books.yes.bestAsk.toFixed(3)} + NO=${books.no.bestAsk.toFixed(3)} = ${combined.toFixed(3)}. ` +
      `After slippage: ${actualCostPerSet.toFixed(3)}. Net edge: ${(netEdge * 100).toFixed(1)}%`,
  };
}

// ── Confidence scoring (multi-factor, per signal type) ──

function computeConfidence(
  market: Market,
  priorYes: number,
  posteriorYes: number,
  signalCount: number,
  signalNames: string[],
): number {
  let confidence = 0.40;

  // More agreeing signals = higher confidence
  confidence += Math.min(0.20, signalCount * 0.07);

  // Posterior diverged far from prior = signals are strong
  const priorDelta = Math.abs(posteriorYes - priorYes);
  if (priorDelta > 0.05) confidence += 0.05;
  if (priorDelta > 0.10) confidence += 0.08;
  if (priorDelta > 0.20) confidence += 0.07;

  // External price (Black-Scholes) is the most reliable signal
  if (signalNames.includes("external-price")) confidence += 0.05;

  // Momentum with persistence adds conviction
  if (signalNames.includes("price-momentum")) confidence += 0.03;

  // LLM prior provides independent reasoning
  if (signalNames.includes("llm-prior")) confidence += 0.05;

  // Time to expiry: closer = more certain for crypto
  if (market.category === "crypto-updown") {
    const hoursLeft = (market.windowEnd - Date.now()) / (1000 * 3600);
    if (hoursLeft < 0.5) confidence += 0.08;
    else if (hoursLeft < 1) confidence += 0.05;
    else if (hoursLeft < 2) confidence += 0.02;
  }

  return Math.min(0.95, confidence);
}

// ── Main evaluation pipeline ──

/**
 * Evaluate a market:
 * 1. Complete-set check (risk-free arb, always first)
 * 2. Bayesian snapshot: prior (midpoint) + signals → posterior
 * 3. LMSR inefficiency detection: posterior vs ask prices
 */
export async function evaluateMarket(market: Market): Promise<Signal | null> {
  // Hard filter: only markets closing within 48 hours
  const hoursToClose = (market.windowEnd - Date.now()) / (1000 * 3600);
  if (hoursToClose > 48) return trackSkip("beyond-48h");
  if (hoursToClose < 0) return trackSkip("expired");

  // For crypto markets, check time + price data BEFORE fetching order book
  if (market.category === "crypto-updown") {
    const now = Date.now();
    const timeRemaining = (market.windowEnd - now) / 1000;
    if (timeRemaining > 172800) return trackSkip("too-far-from-expiry"); // 48h
    if (timeRemaining < 10) return trackSkip("too-close-to-expiry");

    if (market.asset) {
      const symbol = ASSET_TO_SYMBOL[market.asset];
      if (!symbol) return trackSkip("no-symbol");
      const cp = getPrice(symbol);
      if (!cp) return trackSkip("no-price-data");

      // Set strike price from Coinbase if not parsed from question
      if (!market.strikePrice && cp.price > 0) {
        market.strikePrice = cp.price;
      }
    }
  }

  // For general markets, cooldown per market to avoid hammering LLM
  if (market.category !== "crypto-updown") {
    const lastEval = llmCooldowns.get(market.marketId) || 0;
    if (Date.now() - lastEval < BAYESIAN.llmCooldownMs) return trackSkip("llm-cooldown");
    llmCooldowns.set(market.marketId, Date.now());
  }

  // Get fresh order book
  let books: MarketBooks;
  try {
    books = await getMarketBooks(market);
  } catch {
    return trackSkip("clob-error");
  }

  // Detect failed CLOB (both books wide spread = API down)
  const clobFailed = books.yes.spread >= 0.99 && books.no.spread >= 0.99;
  if (clobFailed) {
    books = fallbackBooks(market);
  } else {
    market.currentYes = books.yes.midpoint;
    market.currentNo = books.no.midpoint;
  }

  const booksIlliquid = !clobFailed && books.yes.spread > 0.80 && books.no.spread > 0.80;
  if (booksIlliquid) return trackSkip("illiquid-books");

  // Strategy 1: Complete-set (risk-free, always check first)
  const csSignal = evaluateCompleteSet(market, books);
  if (csSignal) return csSignal;

  // Rate-limit Bayesian updates
  if (!canEvaluate(market.marketId, BAYESIAN.updateIntervalMs)) {
    return trackSkip("update-cooldown");
  }

  // Strategy 2: Bayesian snapshot → LMSR inefficiency
  const coinbase = market.asset
    ? getPrice(ASSET_TO_SYMBOL[market.asset] || "btcusdt")
    : null;

  const signals = await extractSignals(market, books, coinbase);
  if (signals.length === 0) return trackSkip("no-signals");

  // Snapshot: prior (midpoint) + signals → posterior (no accumulation)
  const snapshot = computePosterior(books, signals);

  // LMSR inefficiency detection (with liquidity discount)
  const inefficiency = detectInefficiency(
    snapshot.posteriorYes,
    books,
    BAYESIAN.minEdgeThreshold,
  );

  if (!inefficiency) return trackSkip("no-edge");

  const signalNames = signals.map(s => s.name);
  const confidence = computeConfidence(
    market,
    snapshot.priorYes,
    snapshot.posteriorYes,
    signals.length,
    signalNames,
  );

  log.info("Bayesian-LMSR signal", {
    q: market.question.slice(0, 60),
    posterior: snapshot.posteriorYes.toFixed(3),
    prior: snapshot.priorYes.toFixed(3),
    side: inefficiency.side,
    edge: (inefficiency.edge * 100).toFixed(1) + "%",
    signals: signalNames.join("+"),
    confidence: confidence.toFixed(2),
    b: inefficiency.b.toFixed(0),
  });

  return {
    strategy: "bayesian-lmsr",
    market,
    action: inefficiency.side,
    edge: inefficiency.edge,
    confidence,
    fairValue: snapshot.posteriorYes,
    reasoning: `Bayesian: posterior=${(snapshot.posteriorYes * 100).toFixed(1)}% ` +
      `(prior=${(snapshot.priorYes * 100).toFixed(1)}%, signals=${signalNames.join("+")}). ` +
      `${inefficiency.side} edge=${(inefficiency.edge * 100).toFixed(1)}%, ` +
      `market=${inefficiency.marketYes.toFixed(3)}, b=${inefficiency.b.toFixed(0)}`,
  };
}
