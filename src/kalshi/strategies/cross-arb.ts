import { createLogger } from "../../logger";
import { KALSHI_TRADING } from "../config";
import { KalshiMarket, KalshiSignal } from "../types";

const log = createLogger("cross-arb");

// ─── Polymarket price cache ───
// Updated externally by evaluator when Polymarket data is available

interface PolymarketPrice {
  question: string;
  yesPrice: number;
  noPrice: number;
  slug: string;
}

const polyPrices: Map<string, PolymarketPrice> = new Map();

export function updatePolymarketPrices(prices: PolymarketPrice[]): void {
  polyPrices.clear();
  for (const p of prices) {
    // Key by normalized question for matching
    polyPrices.set(normalizeQuestion(p.question), p);
  }
  log.debug("Updated Polymarket prices", { count: prices.length });
}

// ─── Question normalization & matching ───

function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(b.split(" ").filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  return overlap / Math.min(wordsA.size, wordsB.size);
}

function findPolyMatch(kalshiMarket: KalshiMarket): PolymarketPrice | null {
  const kalshiQ = normalizeQuestion(`${kalshiMarket.title} ${kalshiMarket.subtitle}`);
  let bestMatch: PolymarketPrice | null = null;
  let bestScore = 0;

  for (const [polyQ, polyPrice] of polyPrices) {
    const score = wordOverlap(kalshiQ, polyQ);
    if (score > bestScore && score >= 0.70) {
      bestScore = score;
      bestMatch = polyPrice;
    }
  }

  return bestMatch;
}

// ─── Strategy entry point ───

export function evaluateCrossArb(market: KalshiMarket): KalshiSignal | null {
  const polyMatch = findPolyMatch(market);
  if (!polyMatch) return null;

  // Use Polymarket price as "fair value"
  const polyYes = polyMatch.yesPrice;
  const kalshiYes = market.yes_ask;
  const kalshiNo = market.no_ask;

  // Check both directions
  const yesDiff = polyYes - kalshiYes;    // if positive, Kalshi YES is cheap
  const noDiff = (1 - polyYes) - kalshiNo; // if positive, Kalshi NO is cheap

  let side: "yes" | "no";
  let edge: number;
  let fairValue: number;
  let marketPrice: number;

  if (yesDiff > noDiff && yesDiff > KALSHI_TRADING.crossArbMinEdge) {
    side = "yes";
    edge = yesDiff;
    fairValue = polyYes;
    marketPrice = kalshiYes;
  } else if (noDiff > KALSHI_TRADING.crossArbMinEdge) {
    side = "no";
    edge = noDiff;
    fairValue = 1 - polyYes;
    marketPrice = kalshiNo;
  } else {
    return null;
  }

  // Confidence based on spread magnitude and Polymarket liquidity
  const confidence = Math.min(0.85, 0.60 + edge * 2);

  log.info("Cross-arb signal", {
    kalshi: market.ticker,
    poly: polyMatch.slug,
    polyYes: polyYes.toFixed(3),
    kalshiYes: kalshiYes.toFixed(3),
    side,
    edge: (edge * 100).toFixed(1) + "%",
  });

  return {
    strategy: "cross-arb",
    market,
    side,
    fairValue,
    marketPrice,
    edge,
    confidence,
    categoryMultiplier: 1.0,
    reasoning: `Cross-platform arb: Polymarket "${polyMatch.question.slice(0, 50)}" YES=${(polyYes * 100).toFixed(1)}%, ` +
      `Kalshi "${market.title.slice(0, 50)}" ${side.toUpperCase()} ask=${(marketPrice * 100).toFixed(1)}%. ` +
      `Spread: ${(edge * 100).toFixed(1)}%`,
  };
}

export function hasPolymarketData(): boolean {
  return polyPrices.size > 0;
}
