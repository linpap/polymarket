import { createLogger } from "../logger";
import { TARGET_CATEGORIES, KALSHI_TRADING } from "./config";
import { KalshiMarket, KalshiCategory } from "./types";
import { fetchOpenMarkets } from "./api";

const log = createLogger("kalshi-scanner");

let activeMarkets: KalshiMarket[] = [];
let scanTimer: ReturnType<typeof setInterval> | null = null;

// ─── Category detection ───

export function detectCategory(market: KalshiMarket): KalshiCategory {
  const title = market.title.toLowerCase();
  const cat = market.category.toLowerCase();
  const ticker = market.ticker.toLowerCase();

  // Crypto
  if (cat.includes("crypto") || title.includes("bitcoin") || title.includes("ethereum") || title.includes("crypto")) return "crypto";
  if (ticker.includes("btc") || ticker.includes("eth") || ticker.includes("sol")) return "crypto";

  // Economics
  if (cat.includes("economics") || cat.includes("financial")) return "economics";
  if (title.includes("inflation") || title.includes("unemployment") || title.includes("gdp") || title.includes("ipo")) return "economics";

  // Politics
  if (cat.includes("politics") || cat.includes("election")) return "politics";
  if (title.includes("president") || title.includes("congress") || title.includes("trump") || title.includes("senate")) return "politics";

  // Weather
  if (cat.includes("weather") || cat.includes("climate")) return "weather";

  return "other";
}

// ─── Market filtering ───

function isEligible(market: KalshiMarket): boolean {
  // Must be active (Kalshi uses "active" not "open")
  if (market.status !== "active" && market.status !== "open") return false;

  // Skip sports parlays/multivariate (these are complex multi-leg bets)
  if (market.ticker.includes("KXMVE") || market.ticker.includes("MULTIGAME")) return false;

  // Volume filter
  if (market.volume_24h < KALSHI_TRADING.minVolume24h) return false;

  // Spread filter — only check if both prices are nonzero
  if (market.yes_ask > 0 && market.yes_bid > 0) {
    const spread = market.yes_ask - market.yes_bid;
    if (spread > KALSHI_TRADING.maxSpread) return false;
  }

  // Time to close filter
  const closeTime = new Date(market.close_time).getTime();
  if (isNaN(closeTime)) return false;
  const now = Date.now();
  const secondsToClose = (closeTime - now) / 1000;

  if (secondsToClose < KALSHI_TRADING.minTimeToClose) return false;
  if (secondsToClose > KALSHI_TRADING.maxTimeToClose) return false;

  // Must have valid ask price on at least one side
  if (market.yes_ask <= 0 && market.no_ask <= 0) return false;

  // Filter to target categories
  const cat = market.category;
  if (!TARGET_CATEGORIES.some((tc) => cat.includes(tc))) return false;

  return true;
}

// ─── Scanning ───

async function scan(): Promise<void> {
  try {
    // Fetch a broad set of markets (paginated)
    const allMarkets = await fetchOpenMarkets(500);

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
      categories: [...new Set(activeMarkets.map((m) => m.category))].join(", ") || "none",
    });
  } catch (e) {
    log.error("Scan failed", (e as Error).message);
  }
}

// ─── Public API ───

export async function startScanner(): Promise<void> {
  log.info("Starting Kalshi market scanner", {
    categories: TARGET_CATEGORIES.join(", "),
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
