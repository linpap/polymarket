/**
 * LMSR inefficiency detection.
 *
 * Compares our Bayesian posterior against market ask prices
 * to find actionable edge. Estimates liquidity parameter b
 * from orderbook depth to gauge how much edge is real vs noise.
 */

import { MarketBooks } from "../types";

export interface InefficiencySignal {
  side: "buy-yes" | "buy-no";
  edge: number;         // |fair - market_price|
  fairYes: number;      // our Bayesian fair P(YES)
  marketYes: number;    // market YES ask price
  b: number;            // estimated liquidity parameter
}

/**
 * Estimate liquidity parameter b from orderbook depth.
 * Higher b = more liquid = detected edge is more trustworthy.
 * Low b = thin book = edge might be noise from wide spreads.
 */
export function estimateB(books: MarketBooks): number {
  const totalDepth = books.yes.askDepthUsd + books.yes.bidDepthUsd +
    books.no.askDepthUsd + books.no.bidDepthUsd;
  return Math.max(50, totalDepth / Math.LN2);
}

/**
 * Compare our Bayesian posterior against the market's ask prices.
 * Returns a signal if the edge exceeds threshold.
 *
 * Edge is scaled down when liquidity (b) is low, since thin markets
 * have wide spreads that create phantom edge.
 */
export function detectInefficiency(
  belief: number,       // our posterior P(YES)
  books: MarketBooks,
  threshold: number,    // minimum edge to trigger
): InefficiencySignal | null {
  const fairYes = Math.max(0.01, Math.min(0.99, belief));
  const fairNo = 1 - fairYes;

  const marketYesAsk = books.yes.bestAsk;
  const marketNoAsk = books.no.bestAsk;

  // Edge: how much cheaper can we buy vs fair value?
  const yesEdge = fairYes - marketYesAsk;
  const noEdge = fairNo - marketNoAsk;

  const b = estimateB(books);

  // Discount edge in thin markets: b < 100 = very thin, scale down
  const liquidityDiscount = Math.min(1, b / 100);

  const adjYesEdge = yesEdge * liquidityDiscount;
  const adjNoEdge = noEdge * liquidityDiscount;

  if (adjYesEdge > adjNoEdge && adjYesEdge > threshold) {
    return {
      side: "buy-yes",
      edge: adjYesEdge,
      fairYes,
      marketYes: marketYesAsk,
      b,
    };
  }

  if (adjNoEdge > threshold) {
    return {
      side: "buy-no",
      edge: adjNoEdge,
      fairYes,
      marketYes: marketYesAsk,
      b,
    };
  }

  return null;
}
