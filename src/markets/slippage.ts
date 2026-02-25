import { createLogger } from "../logger";
import { TRADING } from "../config";
import { OrderBook, SlippageEstimate } from "../types";

const log = createLogger("slippage");

/**
 * Walk the order book to compute VWAP for a given USD order size.
 *
 * For a buy order, walks the ask side:
 *   Level 1: 100 shares @ $0.50 -> fill 100 ($50)
 *   Level 2: 200 shares @ $0.52 -> fill 200 ($104)
 *   Level 3: 500 shares @ $0.55 -> fill remaining
 *   VWAP = total_cost / total_shares
 */
export function computeSlippage(book: OrderBook, orderSizeUsd: number): SlippageEstimate {
  if (book.asks.length === 0 || orderSizeUsd <= 0) {
    return { vwap: book.bestAsk || 1, slippagePct: 1, fillableShares: 0, fillableUsd: 0, feasible: false };
  }

  let remainingUsd = orderSizeUsd;
  let totalShares = 0;
  let totalCost = 0;

  for (const level of book.asks) {
    if (remainingUsd <= 0) break;

    const levelCostPerShare = level.price;
    const levelMaxUsd = level.size * levelCostPerShare;

    if (levelMaxUsd >= remainingUsd) {
      // This level can fill the rest
      const sharesToFill = remainingUsd / levelCostPerShare;
      totalShares += sharesToFill;
      totalCost += remainingUsd;
      remainingUsd = 0;
    } else {
      // Take entire level
      totalShares += level.size;
      totalCost += levelMaxUsd;
      remainingUsd -= levelMaxUsd;
    }
  }

  const filled = remainingUsd <= 0.01; // fully filled (within rounding)
  const vwap = totalShares > 0 ? totalCost / totalShares : book.bestAsk;
  const slippagePct = book.bestAsk > 0 ? (vwap - book.bestAsk) / book.bestAsk : 0;

  // Total fillable in top levels
  const fillableShares = book.asks.reduce((s, l) => s + l.size, 0);
  const fillableUsd = book.asks.reduce((s, l) => s + l.price * l.size, 0);

  return {
    vwap,
    slippagePct: Math.max(0, slippagePct),
    fillableShares,
    fillableUsd,
    feasible: filled,
  };
}

/**
 * Run all slippage gates. Returns null if the trade passes, or a skip reason string.
 */
export function checkSlippageGates(
  book: OrderBook,
  orderSizeUsd: number,
  edge: number,
): { pass: boolean; reason?: string; slippage: SlippageEstimate } {
  const slippage = computeSlippage(book, orderSizeUsd);

  // Gate 1: Top-5 book depth > $500
  const top5Depth = book.asks.slice(0, 5).reduce((s, l) => s + l.price * l.size, 0);
  if (top5Depth < TRADING.minBookDepthUsd) {
    return { pass: false, reason: `thin-book($${top5Depth.toFixed(0)})`, slippage };
  }

  // Gate 2: Slippage < 3%
  if (slippage.slippagePct > TRADING.maxSlippagePct) {
    return { pass: false, reason: `high-slippage(${(slippage.slippagePct * 100).toFixed(1)}%)`, slippage };
  }

  // Gate 3: Net edge after slippage > 2%
  const netEdge = edge - slippage.slippagePct;
  if (netEdge < TRADING.minEdgeAfterSlippage) {
    return { pass: false, reason: `low-net-edge(${(netEdge * 100).toFixed(1)}%)`, slippage };
  }

  // Gate 4: Position < 50% of visible depth
  if (slippage.fillableUsd > 0 && orderSizeUsd > slippage.fillableUsd * TRADING.maxPositionPctOfBook) {
    return { pass: false, reason: `size-exceeds-book`, slippage };
  }

  // Gate 5: Order must be fully fillable
  if (!slippage.feasible) {
    return { pass: false, reason: `insufficient-depth`, slippage };
  }

  return { pass: true, slippage };
}
