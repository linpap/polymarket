import { createLogger } from "../logger";
import { TRADING } from "../config";
import { Signal, MarketBooks, SlippageEstimate } from "../types";
import { checkSlippageGates, computeSlippage } from "../markets/slippage";

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
 * For buy-both (complete-set), checks slippage on BOTH books.
 */
export function sizePosition(
  signal: Signal,
  bankroll: number,
  books: MarketBooks,
): Signal | null {
  if (signal.action === "buy-both") {
    return sizeBuyBoth(signal, bankroll, books);
  }

  const book = signal.action === "buy-yes" ? books.yes : books.no;
  const entryPrice = book.bestAsk;

  if (entryPrice <= 0 || entryPrice >= 1) return null;

  // Estimate probability of winning
  const p = signal.fairValue !== undefined
    ? (signal.action === "buy-yes" ? signal.fairValue : 1 - signal.fairValue)
    : Math.min(0.95, entryPrice + signal.edge);
  const q = 1 - p;

  // Payout odds: buy at $0.40, get $1 on win -> payout = 1.5x
  const b = (1 / entryPrice) - 1;

  let kelly = (b * p - q) / b;
  if (kelly <= 0) {
    log.debug("Kelly <= 0, no edge", { p: p.toFixed(3), b: b.toFixed(2), kelly: kelly.toFixed(4) });
    return null;
  }

  kelly *= TRADING.kellyFraction;

  let size = Math.min(
    bankroll * kelly,
    bankroll * TRADING.maxPositionPct,
    TRADING.maxPositionUsd,
    bankroll,
  );

  if (size < 1) return null;

  // Slippage gates
  const { pass, reason, slippage } = checkSlippageGates(book, size, signal.edge);
  if (!pass) {
    log.debug("Slippage gate failed", { reason, size: size.toFixed(2) });
    return null;
  }

  const shares = size / slippage.vwap;

  log.info("Position sized", {
    strategy: signal.strategy,
    kelly: (kelly * 100).toFixed(1) + "%",
    size: "$" + size.toFixed(2),
    shares: shares.toFixed(2),
    vwap: slippage.vwap.toFixed(4),
    slippage: (slippage.slippagePct * 100).toFixed(2) + "%",
  });

  return { ...signal, size, shares, slippage };
}

/**
 * Size a complete-set (buy-both) trade.
 * Must check slippage on BOTH YES and NO books.
 */
function sizeBuyBoth(
  signal: Signal,
  bankroll: number,
  books: MarketBooks,
): Signal | null {
  // For complete-set, edge is guaranteed: 1 - (yesVWAP + noVWAP)
  let maxPct = 0.10;
  let maxUsd = 1000;

  let size = Math.min(bankroll * maxPct, maxUsd, bankroll);
  if (size < 2) return null;

  // Split equally between YES and NO
  const halfSize = size / 2;

  // Check slippage on both sides
  const yesGate = checkSlippageGates(books.yes, halfSize, signal.edge);
  const noGate = checkSlippageGates(books.no, halfSize, signal.edge);

  if (!yesGate.pass) {
    log.debug("Complete-set YES slippage gate failed", { reason: yesGate.reason });
    return null;
  }
  if (!noGate.pass) {
    log.debug("Complete-set NO slippage gate failed", { reason: noGate.reason });
    return null;
  }

  // Actual cost per share after slippage on both sides
  const costPerSet = yesGate.slippage.vwap + noGate.slippage.vwap;
  if (costPerSet >= 1.0) {
    log.debug("Complete-set VWAP cost >= $1, no profit after slippage");
    return null;
  }

  const shares = halfSize / yesGate.slippage.vwap; // shares of each side

  // Build a combined slippage estimate
  const combinedSlippage: SlippageEstimate = {
    vwap: costPerSet, // total cost per set
    slippagePct: (costPerSet - books.combinedAsk) / books.combinedAsk,
    fillableShares: Math.min(yesGate.slippage.fillableShares, noGate.slippage.fillableShares),
    fillableUsd: yesGate.slippage.fillableUsd + noGate.slippage.fillableUsd,
    feasible: yesGate.slippage.feasible && noGate.slippage.feasible,
  };

  log.info("Complete-set sized", {
    size: "$" + size.toFixed(2),
    shares: shares.toFixed(2),
    yesVwap: yesGate.slippage.vwap.toFixed(4),
    noVwap: noGate.slippage.vwap.toFixed(4),
    costPerSet: costPerSet.toFixed(4),
    netEdge: ((1 - costPerSet) * 100).toFixed(1) + "%",
  });

  return { ...signal, size, shares, slippage: combinedSlippage };
}
