import { createLogger } from "../logger";
import { TRADING, ASSET_TO_SYMBOL } from "../config";
import { Market, MarketBooks, CoinbasePrice, Signal } from "../types";
import { getPrice } from "../feeds/coinbase";

const log = createLogger("vol-fair");

/**
 * Standard normal CDF (Abramowitz & Stegun approximation)
 */
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

/**
 * Black-Scholes log-normal model: probability of price being above strike
 * at expiry, using realized volatility from the Coinbase rolling window.
 */
function logNormalProbAbove(
  currentPrice: number,
  strike: number,
  hoursToExpiry: number,
  annualVol: number,
): number {
  const hoursPerYear = 365.25 * 24;
  const sigma = annualVol * Math.sqrt(hoursToExpiry / hoursPerYear);

  if (sigma <= 0) {
    return currentPrice >= strike ? 0.99 : 0.01;
  }

  // d2 in Black-Scholes (zero drift for short timeframes)
  const d2 = (Math.log(currentPrice / strike) - 0.5 * sigma * sigma) / sigma;
  return normalCDF(d2);
}

/**
 * Volatility Fair Value strategy for crypto up/down markets.
 *
 * Uses Black-Scholes with realized vol to compute fair probability,
 * then compares against market ask prices.
 */
export function evaluateVolatilityFair(
  market: Market,
  books: MarketBooks,
): Signal | null {
  if (market.category !== "crypto-updown") return null;
  if (!market.asset || !market.strikePrice) return null;

  const symbol = ASSET_TO_SYMBOL[market.asset];
  if (!symbol) return null;

  const coinbase = getPrice(symbol);
  if (!coinbase) return null;

  const hoursToExpiry = (market.windowEnd - Date.now()) / (1000 * 3600);
  if (hoursToExpiry <= 0) return null;

  // Use realized vol from Coinbase feed, which adapts to current regime
  const annualVol = coinbase.realizedVol;

  // Probability of being above strike at expiry
  const probAbove = logNormalProbAbove(coinbase.price, market.strikePrice, hoursToExpiry, annualVol);

  // In up/down markets, "YES" = "Up" (price above reference)
  const fairYes = probAbove;
  const fairNo = 1 - probAbove;

  // Check edges on both sides
  const yesEdge = fairYes - books.yes.bestAsk;
  const noEdge = fairNo - books.no.bestAsk;

  let action: "buy-yes" | "buy-no";
  let edge: number;
  let entryPrice: number;

  if (yesEdge > noEdge && yesEdge > TRADING.minEdgeAfterSlippage) {
    action = "buy-yes";
    edge = yesEdge;
    entryPrice = books.yes.bestAsk;
  } else if (noEdge > TRADING.minEdgeAfterSlippage) {
    action = "buy-no";
    edge = noEdge;
    entryPrice = books.no.bestAsk;
  } else {
    return null;
  }

  // Confidence based on distance from strike and time
  const distanceRatio = Math.abs(coinbase.price - market.strikePrice) / market.strikePrice;
  let confidence = 0.50 + Math.min(0.35, distanceRatio * 5);
  if (hoursToExpiry < 0.5) confidence = Math.min(0.95, confidence + 0.10);
  if (hoursToExpiry < 0.08) confidence = Math.min(0.95, confidence + 0.10); // <5min

  log.info("Vol-fair signal", {
    asset: market.asset,
    price: "$" + coinbase.price.toLocaleString(),
    strike: "$" + market.strikePrice.toLocaleString(),
    vol: (annualVol * 100).toFixed(0) + "%",
    fairYes: fairYes.toFixed(3),
    action,
    edge: (edge * 100).toFixed(1) + "%",
    hours: hoursToExpiry.toFixed(2),
  });

  return {
    strategy: "volatility-fair",
    market,
    action,
    edge,
    confidence,
    fairValue: fairYes,
    reasoning: `Vol-fair: ${market.asset} $${coinbase.price.toLocaleString()} vs strike $${market.strikePrice.toLocaleString()}. ` +
      `RealizedVol=${(annualVol * 100).toFixed(0)}%, fair YES=${(fairYes * 100).toFixed(1)}%, ` +
      `${action} at ${entryPrice.toFixed(3)}, edge=${(edge * 100).toFixed(1)}%, ${hoursToExpiry.toFixed(2)}h left`,
  };
}
