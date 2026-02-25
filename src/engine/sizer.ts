import { createLogger } from "../logger";
import { TRADING } from "../config";
import { Signal, OrderBook, SlippageEstimate } from "../types";
import { checkSlippageGates } from "../markets/slippage";

const log = createLogger("sizer");

/**
 * Kelly Criterion position sizing with slippage-adjusted edge.
 *
 * kelly = (b*p - q) / b
 * where:
 *   p = probability of winning (fairValue or confidence-derived)
 *   q = 1 - p
 *   b = payout odds = (1/entryPrice) - 1
 *
 * Then apply:
 *   - Conservative Kelly fraction (20%)
 *   - Max position % of bankroll
 *   - Max position USD cap
 *   - Slippage gates
 */
export function sizePosition(
  signal: Signal,
  bankroll: number,
  book: OrderBook,
): Signal | null {
  // Determine entry price and probability
  const entryPrice = signal.action === "buy-yes"
    ? book.bestAsk
    : book.bestAsk; // we always buy on ask side

  if (entryPrice <= 0 || entryPrice >= 1) return null;

  // Estimate probability of winning
  // Use fairValue if available (vol-fair, llm-fair), else derive from edge + entry
  const p = signal.fairValue !== undefined
    ? (signal.action === "buy-yes" ? signal.fairValue : 1 - signal.fairValue)
    : Math.min(0.95, entryPrice + signal.edge);
  const q = 1 - p;

  // Payout odds: if we buy at $0.40, we get $1 on win -> payout = 1.5x
  const b = (1 / entryPrice) - 1;

  // Kelly fraction
  let kelly = (b * p - q) / b;
  if (kelly <= 0) {
    log.debug("Kelly <= 0, no edge", { p: p.toFixed(3), b: b.toFixed(2), kelly: kelly.toFixed(4) });
    return null;
  }

  // Conservative: use 20% of full Kelly
  kelly *= TRADING.kellyFraction;

  // Complete-set gets larger sizing (guaranteed profit)
  let maxPct: number = TRADING.maxPositionPct;
  let maxUsd: number = TRADING.maxPositionUsd;
  if (signal.strategy === "complete-set") {
    maxPct = 0.10;
    maxUsd = 1000;
  }

  // Compute size
  let size = Math.min(
    bankroll * kelly,
    bankroll * maxPct,
    maxUsd,
    bankroll,
  );

  if (size < 1) return null;

  // Run slippage gates
  const { pass, reason, slippage } = checkSlippageGates(book, size, signal.edge);
  if (!pass) {
    log.debug("Slippage gate failed", { reason, size: size.toFixed(2) });
    return null;
  }

  // Adjust size: use VWAP fill price for share calculation
  const shares = size / slippage.vwap;

  log.info("Position sized", {
    strategy: signal.strategy,
    kelly: (kelly * 100).toFixed(1) + "%",
    size: "$" + size.toFixed(2),
    shares: shares.toFixed(2),
    vwap: slippage.vwap.toFixed(4),
    slippage: (slippage.slippagePct * 100).toFixed(2) + "%",
  });

  return {
    ...signal,
    size,
    shares,
    slippage,
  };
}
