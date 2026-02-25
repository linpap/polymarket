import { createLogger } from "../logger";
import { TRADING } from "../config";
import { Market, MarketBooks, Signal } from "../types";
import { computeSlippage } from "../markets/slippage";

const log = createLogger("complete-set");

/**
 * Complete-Set Arbitrage: If YES_ask + NO_ask < $0.98, buy both for guaranteed profit.
 * Risk-free — only needs detection and sufficient book depth.
 */
export function evaluateCompleteSet(market: Market, books: MarketBooks): Signal | null {
  const combined = books.combinedAsk;

  if (combined >= TRADING.completeSetThreshold) return null;

  const rawEdge = 1.0 - combined;

  // Compute slippage for both sides (half the order on each)
  const testSize = Math.min(500, rawEdge * 5000); // scale test size to edge
  const yesSlip = computeSlippage(books.yes, testSize / 2);
  const noSlip = computeSlippage(books.no, testSize / 2);

  // Actual cost per set after slippage
  const actualCostPerSet = yesSlip.vwap + noSlip.vwap;
  if (actualCostPerSet >= 1.0) return null; // slippage eats the edge

  const netEdge = 1.0 - actualCostPerSet;
  if (netEdge < 0.005) return null; // need at least 0.5% after slippage

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
