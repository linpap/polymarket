import { createLogger } from "../logger";
import { ASSET_TO_SYMBOL } from "../config";
import { Market, MarketBooks, Signal } from "../types";
import { getMarketBooks } from "../markets/orderbook";
import { getPrice } from "../feeds/coinbase";
import { evaluateCompleteSet } from "./complete-set";
import { evaluateVolatilityFair } from "./volatility-fair";
import { evaluateLatency } from "./latency";
import { evaluateOrderbookImbalance } from "./orderbook-imbalance";
import { evaluateLLMFair } from "./llm-fair";

const log = createLogger("strategies");

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

// ── Main evaluation pipeline ──

/**
 * Evaluate a market through all strategies in priority order:
 * 1. Complete-set (risk-free, always check first)
 * 2. Volatility-fair (crypto up/down, statistical edge)
 * 3. Latency (crypto up/down, momentum-based)
 * 4. Orderbook imbalance (all markets, experimental)
 * 5. LLM fair value (general markets, expensive so last)
 */
export async function evaluateMarket(market: Market): Promise<Signal | null> {
  // For crypto markets, ensure we have price data
  if (market.category === "crypto-updown" && market.asset) {
    const symbol = ASSET_TO_SYMBOL[market.asset];
    if (!symbol) return trackSkip("no-symbol");
    if (!getPrice(symbol)) return trackSkip("no-price-data");
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
    // Update market with live prices
    market.currentYes = books.yes.midpoint;
    market.currentNo = books.no.midpoint;
  }

  const booksIlliquid = !clobFailed && books.yes.spread > 0.80 && books.no.spread > 0.80;

  // Strategy 1: Complete-set (always, risk-free)
  if (!booksIlliquid) {
    const csSignal = evaluateCompleteSet(market, books);
    if (csSignal) return csSignal;
  }

  // Strategy 2: Volatility-fair (crypto up/down)
  if (!booksIlliquid && market.category === "crypto-updown") {
    const vfSignal = evaluateVolatilityFair(market, books);
    if (vfSignal) return vfSignal;
  }

  // Strategy 3: Latency (crypto up/down)
  if (!booksIlliquid && market.category === "crypto-updown") {
    const latSignal = evaluateLatency(market, books);
    if (latSignal) return latSignal;
  }

  // Strategy 4: Orderbook imbalance (all markets)
  if (!booksIlliquid) {
    const obSignal = evaluateOrderbookImbalance(market, books);
    if (obSignal) return obSignal;
  }

  // Strategy 5: LLM fair value (non-crypto, expensive so last)
  if (market.category !== "crypto-updown") {
    const llmSignal = await evaluateLLMFair(market, books);
    if (llmSignal) return llmSignal;
  }

  // Track skip reason
  if (booksIlliquid) return trackSkip("illiquid-books");
  if (market.category === "crypto-updown") {
    const now = Date.now();
    const timeRemaining = (market.windowEnd - now) / 1000;
    if (timeRemaining > 1800) return trackSkip("too-far-from-expiry");
    if (timeRemaining < 10) return trackSkip("too-close-to-expiry");
    return trackSkip("no-edge");
  }
  return trackSkip("no-edge");
}
