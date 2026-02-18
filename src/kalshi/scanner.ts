import { createLogger } from "../logger";
import { SERIES_TICKERS, KALSHI_TRADING } from "./config";
import { KalshiMarket, KalshiCategory } from "./types";
import { fetchMarketsBySeries } from "./api";

const log = createLogger("kalshi-scanner");

let activeMarkets: KalshiMarket[] = [];
let scanTimer: ReturnType<typeof setInterval> | null = null;

// ─── Category detection ───

export function detectCategory(market: KalshiMarket): KalshiCategory {
  const series = market.series_ticker.toUpperCase();
  const title = market.title.toLowerCase();
  const cat = market.category.toLowerCase();

  // Crypto
  if (series.startsWith("KXBTC") || series.startsWith("KXETH") || series.startsWith("KXSOL")) return "crypto";
  if (cat.includes("crypto") || title.includes("bitcoin") || title.includes("ethereum")) return "crypto";

  // Economics
  if (["KXFED", "KXCPI", "KXGDP", "KXJOBS", "KXINX"].some((s) => series.startsWith(s))) return "economics";
  if (cat.includes("economics") || cat.includes("financial") || title.includes("fed") || title.includes("inflation")) return "economics";

  // Politics
  if (cat.includes("politics") || title.includes("president") || title.includes("congress") || title.includes("election")) return "politics";

  // Weather
  if (cat.includes("weather") || cat.includes("climate") || title.includes("temperature") || title.includes("hurricane")) return "weather";

  return "other";
}

// ─── Market filtering ───

function isEligible(market: KalshiMarket): boolean {
  // Must be open
  if (market.status !== "open") return false;

  // Volume filter
  if (market.volume_24h < KALSHI_TRADING.minVolume24h) return false;

  // Spread filter
  const spread = market.yes_ask - market.yes_bid;
  if (spread > KALSHI_TRADING.maxSpread) return false;

  // Time to close filter
  const closeTime = new Date(market.close_time).getTime();
  const now = Date.now();
  const secondsToClose = (closeTime - now) / 1000;

  if (secondsToClose < KALSHI_TRADING.minTimeToClose) return false;
  if (secondsToClose > KALSHI_TRADING.maxTimeToClose) return false;

  // Must have valid prices
  if (market.yes_ask <= 0 || market.no_ask <= 0) return false;

  return true;
}

// ─── Scanning ───

async function scan(): Promise<void> {
  const allMarkets: KalshiMarket[] = [];

  for (const series of SERIES_TICKERS) {
    try {
      const markets = await fetchMarketsBySeries(series);
      allMarkets.push(...markets);
    } catch (e) {
      log.debug(`Failed scanning series ${series}`, (e as Error).message);
    }
  }

  // Filter eligible markets
  const eligible = allMarkets.filter(isEligible);

  // Deduplicate by ticker
  const seen = new Set<string>();
  activeMarkets = eligible.filter((m) => {
    if (seen.has(m.ticker)) return false;
    seen.add(m.ticker);
    return true;
  });

  log.info("Scan complete", {
    raw: allMarkets.length,
    eligible: activeMarkets.length,
    series: SERIES_TICKERS.length,
  });
}

// ─── Public API ───

export async function startScanner(): Promise<void> {
  log.info("Starting Kalshi market scanner", {
    series: SERIES_TICKERS.join(", "),
    interval: KALSHI_TRADING.scanIntervalMs,
  });

  // Initial scan
  await scan();

  // Periodic scan
  scanTimer = setInterval(() => {
    scan().catch((e) => log.error("Scan error", (e as Error).message));
  }, KALSHI_TRADING.scanIntervalMs);
}

export function stopScanner(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

export function getActiveMarkets(): KalshiMarket[] {
  return activeMarkets;
}

export function getMarketsByCategory(category: KalshiCategory): KalshiMarket[] {
  return activeMarkets.filter((m) => detectCategory(m) === category);
}
