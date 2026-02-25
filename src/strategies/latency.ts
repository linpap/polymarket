import { createLogger } from "../logger";
import { TRADING, ASSET_TO_SYMBOL } from "../config";
import { Market, MarketBooks, CoinbasePrice, Signal } from "../types";
import { getPrice } from "../feeds/coinbase";

const log = createLogger("latency");

/**
 * Latency Arbitrage: Coinbase price moves faster than Polymarket adjusts.
 *
 * Improvement over v1:
 * - Uses realized vol to define "significant move" (2-sigma), not hardcoded threshold
 * - Factors in momentum persistence (1m and 5m same direction = higher conviction)
 * - Adaptive time windows
 */
export function evaluateLatency(
  market: Market,
  books: MarketBooks,
): Signal | null {
  if (market.category !== "crypto-updown") return null;
  if (!market.asset) return null;

  const symbol = ASSET_TO_SYMBOL[market.asset];
  if (!symbol) return null;

  const coinbase = getPrice(symbol);
  if (!coinbase) return null;

  const now = Date.now();
  const timeRemaining = (market.windowEnd - now) / 1000;

  // Only trade within window, but not too close to expiry
  if (timeRemaining > TRADING.latencyMaxTimeRemaining) return null;
  if (timeRemaining < TRADING.latencyMinTimeRemaining) return null;

  // Adaptive threshold: use realized vol to determine what a "significant" move is
  // 2-sigma move in 1 minute (annualized vol -> per-minute sigma)
  const annualVol = coinbase.realizedVol;
  const minuteVol = annualVol / Math.sqrt(365.25 * 24 * 60); // per-minute sigma
  const sigmaThreshold = TRADING.latencySigmaThreshold * minuteVol;

  const magnitude = Math.abs(coinbase.change1m);
  if (magnitude < sigmaThreshold) return null;

  // Compute number of sigmas this move represents
  const numSigmas = magnitude / minuteVol;

  // Momentum persistence: 1m and 5m in same direction = higher conviction
  const sameDirection = (coinbase.change1m > 0 && coinbase.change5m > 0) ||
    (coinbase.change1m < 0 && coinbase.change5m < 0);

  const priceDirection: "up" | "down" = coinbase.change1m > 0 ? "up" : "down";

  // Determine action based on market direction and price move
  let action: "buy-yes" | "buy-no";
  let entryPrice: number;

  if (market.direction === "up") {
    action = priceDirection === "up" ? "buy-yes" : "buy-no";
  } else {
    action = priceDirection === "down" ? "buy-yes" : "buy-no";
  }

  entryPrice = action === "buy-yes" ? books.yes.bestAsk : books.no.bestAsk;

  // Estimate final value: larger moves + less time = more locked in
  const timeDecay = Math.max(0, 1 - timeRemaining / TRADING.latencyMaxTimeRemaining);
  const magnitudeScore = Math.min(1, numSigmas / 5); // caps at 5 sigma
  const estimated = 0.60 + 0.30 * timeDecay * magnitudeScore;
  const magnitudeBonus = Math.min(0.15, numSigmas * 0.03);
  const estimatedValue = Math.min(0.98, estimated + magnitudeBonus);

  const edge = estimatedValue - entryPrice;
  if (edge < TRADING.minEdgeAfterSlippage) return null;

  // Confidence scoring
  let confidence = 0.45;
  if (numSigmas > 2) confidence += 0.05;
  if (numSigmas > 3) confidence += 0.05;
  if (numSigmas > 4) confidence += 0.10;
  if (numSigmas > 5) confidence += 0.10;
  if (sameDirection) confidence += 0.10; // momentum persistence
  if (timeRemaining < 600) confidence += 0.05;
  if (timeRemaining < 300) confidence += 0.05;
  if (timeRemaining < 120) confidence += 0.05;
  if (timeRemaining < 60) confidence += 0.10;
  if (entryPrice < 0.60) confidence += 0.05;
  if (entryPrice < 0.40) confidence += 0.05;
  confidence = Math.min(0.95, confidence);

  log.info("Latency signal", {
    asset: market.asset,
    dir: priceDirection,
    change1m: (coinbase.change1m * 100).toFixed(3) + "%",
    sigmas: numSigmas.toFixed(1),
    sameDir5m: sameDirection,
    action,
    entry: entryPrice.toFixed(3),
    edge: (edge * 100).toFixed(1) + "%",
    timeLeft: timeRemaining.toFixed(0) + "s",
  });

  return {
    strategy: "latency",
    market,
    action,
    edge,
    confidence,
    reasoning: `Latency: ${market.asset} ${priceDirection} ${(coinbase.change1m * 100).toFixed(2)}% (${numSigmas.toFixed(1)}σ). ` +
      `${sameDirection ? "5m confirms. " : ""}${action} at ${entryPrice.toFixed(3)}, ` +
      `edge=${(edge * 100).toFixed(1)}%, ${timeRemaining.toFixed(0)}s left`,
  };
}
