import { createLogger } from "../../logger";
import { ASSET_TO_SYMBOL, KALSHI_TRADING } from "../config";
import { KalshiMarket, KalshiSignal } from "../types";
import { getPrice } from "../../updown/binance-feed";

const log = createLogger("crypto-price");

// ─── Parse strike price from Kalshi market title ───
// Examples:
//   "Bitcoin above $100,000?" → 100000
//   "Will BTC be above 95000 on Friday?" → 95000
//   "Bitcoin between $90,000 and $95,000?" → { lower: 90000, upper: 95000 }

interface StrikeInfo {
  asset: string;
  strike: number;
  direction: "above" | "below" | "between";
  upperStrike?: number;
}

function parseStrike(market: KalshiMarket): StrikeInfo | null {
  const text = `${market.title} ${market.subtitle}`.toLowerCase();

  // Detect asset
  let asset = "";
  if (text.includes("bitcoin") || text.includes("btc") || market.series_ticker.includes("BTC")) {
    asset = "BTC";
  } else if (text.includes("ethereum") || text.includes("eth") || market.series_ticker.includes("ETH")) {
    asset = "ETH";
  }
  if (!asset) return null;

  // Extract prices — handle $100,000 and 100000 formats
  const pricePattern = /\$?([\d,]+(?:\.\d+)?)/g;
  const prices: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pricePattern.exec(text)) !== null) {
    const val = parseFloat(match[1].replace(/,/g, ""));
    if (val > 1000) prices.push(val); // filter out small numbers
  }

  if (prices.length === 0) return null;

  // Detect direction
  if (text.includes("between") && prices.length >= 2) {
    return {
      asset,
      strike: Math.min(...prices),
      direction: "between",
      upperStrike: Math.max(...prices),
    };
  }

  if (text.includes("below") || text.includes("under")) {
    return { asset, strike: prices[0], direction: "below" };
  }

  // Default: above
  return { asset, strike: prices[0], direction: "above" };
}

// ─── Log-normal probability estimation ───
// Given current price and time to close, estimate probability of
// price being above/below strike at close time.

function logNormalProb(
  currentPrice: number,
  strike: number,
  hoursToClose: number,
  direction: "above" | "below"
): number {
  // Annualized volatility estimate for crypto (~80% for BTC, ~100% for ETH)
  const annualVol = 0.80;
  const hoursPerYear = 365.25 * 24;
  const sigma = annualVol * Math.sqrt(hoursToClose / hoursPerYear);

  if (sigma <= 0) {
    // At expiry — binary outcome
    return direction === "above"
      ? (currentPrice >= strike ? 0.99 : 0.01)
      : (currentPrice < strike ? 0.99 : 0.01);
  }

  // d2 in Black-Scholes (assuming zero drift for short timeframes)
  const d2 = (Math.log(currentPrice / strike) - 0.5 * sigma * sigma) / sigma;

  // Standard normal CDF approximation (Abramowitz & Stegun)
  const probAbove = normalCDF(d2);

  return direction === "above" ? probAbove : 1 - probAbove;
}

function logNormalProbBetween(
  currentPrice: number,
  lower: number,
  upper: number,
  hoursToClose: number
): number {
  const pAboveLower = logNormalProb(currentPrice, lower, hoursToClose, "above");
  const pAboveUpper = logNormalProb(currentPrice, upper, hoursToClose, "above");
  return Math.max(0, pAboveLower - pAboveUpper);
}

// Standard normal CDF (Abramowitz & Stegun approximation)
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

// ─── Strategy entry point ───

export function evaluateCryptoPrice(market: KalshiMarket): KalshiSignal | null {
  const strike = parseStrike(market);
  if (!strike) return null;

  const symbol = ASSET_TO_SYMBOL[strike.asset];
  if (!symbol) return null;

  const binance = getPrice(symbol);
  if (!binance) {
    log.debug("No Binance price for", { asset: strike.asset });
    return null;
  }

  // Time to close in hours
  const closeTime = new Date(market.close_time).getTime();
  const hoursToClose = (closeTime - Date.now()) / (1000 * 60 * 60);
  if (hoursToClose <= 0) return null;

  // Compute fair value
  let fairValue: number;
  if (strike.direction === "between" && strike.upperStrike) {
    fairValue = logNormalProbBetween(binance.price, strike.strike, strike.upperStrike, hoursToClose);
  } else {
    fairValue = logNormalProb(binance.price, strike.strike, hoursToClose, strike.direction);
  }

  // Confidence is higher when price is far from strike (more certain outcome)
  const distanceRatio = Math.abs(binance.price - strike.strike) / strike.strike;
  let confidence = 0.5 + Math.min(0.4, distanceRatio * 5);
  // Higher confidence near expiry
  if (hoursToClose < 2) confidence = Math.min(0.95, confidence + 0.1);
  if (hoursToClose < 0.5) confidence = Math.min(0.95, confidence + 0.1);

  // Determine side: buy YES if fairValue > yes_ask, buy NO if (1-fairValue) > no_ask
  const yesEdge = fairValue - market.yes_ask;
  const noEdge = (1 - fairValue) - market.no_ask;

  let side: "yes" | "no";
  let edge: number;
  let marketPrice: number;

  if (yesEdge > noEdge && yesEdge > KALSHI_TRADING.cryptoPriceMinEdge) {
    side = "yes";
    edge = yesEdge;
    marketPrice = market.yes_ask;
  } else if (noEdge > KALSHI_TRADING.cryptoPriceMinEdge) {
    side = "no";
    edge = noEdge;
    marketPrice = market.no_ask;
  } else {
    return null;
  }

  log.info("Crypto price signal", {
    ticker: market.ticker,
    asset: strike.asset,
    binance: binance.price.toFixed(2),
    strike: strike.strike,
    direction: strike.direction,
    fairValue: fairValue.toFixed(3),
    side,
    edge: (edge * 100).toFixed(1) + "%",
  });

  return {
    strategy: "crypto-price",
    market,
    side,
    fairValue,
    marketPrice,
    edge,
    confidence,
    categoryMultiplier: 1.2,
    reasoning: `${strike.asset} at $${binance.price.toLocaleString()}, strike $${strike.strike.toLocaleString()} (${strike.direction}). ` +
      `Log-normal fair value: ${(fairValue * 100).toFixed(1)}%, market ${side} ask: ${(marketPrice * 100).toFixed(1)}%. ` +
      `${hoursToClose.toFixed(1)}h to close. Edge: ${(edge * 100).toFixed(1)}%`,
  };
}
