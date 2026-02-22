import { createLogger } from "../logger";
import { KALSHI_API, KALSHI_POLL_MS } from "./config";
import { KalshiMarket, CrossPlatformOpp, UpDownMarket } from "./types";

const log = createLogger("kalshi-monitor");

let kalshiMarkets: KalshiMarket[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
const crossPlatformOpps: CrossPlatformOpp[] = [];

// ─── Kalshi 15-min Up/Down series tickers ───
// These are the CORRECT series for crypto up/down binary markets.
// NOT KXBTC (price range), NOT KXBTCD (above/below ladder).

const UPDOWN_SERIES = ["KXBTC15M", "KXETH15M", "KXSOL15M"];

const SERIES_TO_ASSET: Record<string, string> = {
  KXBTC15M: "BTC",
  KXETH15M: "ETH",
  KXSOL15M: "SOL",
};

// ─── Kalshi API ───

async function fetchKalshiUpDownMarkets(): Promise<KalshiMarket[]> {
  const allMarkets: KalshiMarket[] = [];

  for (const series of UPDOWN_SERIES) {
    try {
      // Use events endpoint with nested markets — each event has 1 binary market
      const url = `${KALSHI_API}/events?status=open&with_nested_markets=true&series_ticker=${series}&limit=10`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
      });

      if (!resp.ok) {
        log.debug("Kalshi API error for series", { series, status: resp.status });
        continue;
      }

      const data = (await resp.json()) as any;
      const events = data.events || [];

      for (const event of events) {
        const eventMarkets = event.markets || [];
        const asset = SERIES_TO_ASSET[series] || "";

        for (const raw of eventMarkets) {
          if (raw.status !== "active" && raw.status !== "open") continue;

          const market = mapKalshiMarket(raw, asset, event);
          // Only include markets with valid prices
          if (market.yes_ask > 0 || market.yes_bid > 0) {
            allMarkets.push(market);
          }
        }
      }

      log.debug("Kalshi series fetched", { series, count: events.length });
    } catch (e) {
      log.debug("Kalshi fetch error", {
        series,
        error: (e as Error).message,
      });
    }
  }

  return allMarkets;
}

function mapKalshiMarket(raw: any, asset: string, event?: any): KalshiMarket {
  const openTime = raw.open_time || event?.open_time || "";
  const closeTime = raw.close_time || raw.expiration_time || event?.close_time || "";

  return {
    ticker: raw.ticker || "",
    title: raw.title || event?.title || "",
    category: asset, // use asset as category for easy matching
    yes_ask: (raw.yes_ask || 0) / 100, // Kalshi uses cents
    no_ask: (raw.no_ask || 0) / 100,
    yes_bid: (raw.yes_bid || 0) / 100,
    no_bid: (raw.no_bid || 0) / 100,
    close_time: closeTime,
    open_time: openTime,
    close_time_ms: closeTime ? new Date(closeTime).getTime() : 0,
    open_time_ms: openTime ? new Date(openTime).getTime() : 0,
    floor_strike: raw.floor_strike || 0,
    status: raw.status || "",
  };
}

// ─── Cross-platform comparison ───
// Match Kalshi 15-min up/down markets to Polymarket up/down markets
// by asset AND overlapping time windows.

export function findCrossPlatformArb(
  polyMarkets: UpDownMarket[]
): CrossPlatformOpp[] {
  const opps: CrossPlatformOpp[] = [];

  for (const kalshi of kalshiMarkets) {
    const kalshiAsset = kalshi.category; // "BTC", "ETH", or "SOL"

    for (const poly of polyMarkets) {
      // 1. Asset must match
      if (poly.asset !== kalshiAsset) continue;

      // 2. Time windows must overlap
      // Kalshi: [open_time_ms, close_time_ms] (15-min window)
      // Polymarket: [windowStart, windowEnd] (5-min or 15-min window)
      // Overlap = poly.windowStart < kalshi.close_time_ms AND poly.windowEnd > kalshi.open_time_ms
      if (kalshi.close_time_ms === 0 || kalshi.open_time_ms === 0) continue;
      if (poly.windowStart >= kalshi.close_time_ms) continue; // poly starts after kalshi ends
      if (poly.windowEnd <= kalshi.open_time_ms) continue;    // poly ends before kalshi starts

      // 3. Both markets must be asking "will price go up?" — same direction
      // Kalshi 15M markets: YES = price goes up (same as Polymarket direction="up")
      // Only match if Polymarket direction is "up" (which it always is in current setup)
      if (poly.direction !== "up") continue;

      const polyYes = poly.currentYes;
      const kalshiYes = kalshi.yes_ask > 0 ? kalshi.yes_ask : kalshi.yes_bid;
      if (kalshiYes === 0) continue; // no valid Kalshi price

      const spread = Math.abs(polyYes - kalshiYes);

      if (spread > 0.05) {
        opps.push({
          polyMarket: poly,
          kalshiMarket: kalshi,
          polyYes,
          kalshiYes,
          spread,
          direction: polyYes > kalshiYes
            ? "Poly YES overpriced vs Kalshi"
            : "Kalshi YES overpriced vs Poly",
        });
      }
    }
  }

  return opps;
}

async function poll(polyMarkets: UpDownMarket[]): Promise<void> {
  kalshiMarkets = await fetchKalshiUpDownMarkets();

  if (kalshiMarkets.length > 0) {
    log.info("Kalshi 15M up/down markets found", {
      count: kalshiMarkets.length,
      tickers: kalshiMarkets.map((m) => m.ticker).join(", "),
    });

    const opps = findCrossPlatformArb(polyMarkets);
    // Replace stale opps
    crossPlatformOpps.length = 0;
    if (opps.length > 0) {
      for (const opp of opps) {
        log.info("CROSS-PLATFORM OPPORTUNITY", {
          poly: opp.polyMarket.question.slice(0, 60),
          kalshi: `${opp.kalshiMarket.ticker} (${opp.kalshiMarket.title.slice(0, 40)})`,
          polyYes: opp.polyYes.toFixed(3),
          kalshiYes: opp.kalshiYes.toFixed(3),
          spread: (opp.spread * 100).toFixed(1) + "%",
          direction: opp.direction,
        });
        crossPlatformOpps.push(opp);
      }
    } else {
      log.debug("No cross-platform opportunities (prices aligned or no overlapping windows)");
    }
  } else {
    log.debug("No Kalshi 15M up/down markets currently open");
  }
}

// ─── Public API ───

export function startKalshiMonitor(getPolyMarkets: () => UpDownMarket[]): void {
  log.info("Starting Kalshi monitor", {
    pollInterval: KALSHI_POLL_MS,
    series: UPDOWN_SERIES.join(", "),
  });
  poll(getPolyMarkets()); // immediate first poll
  pollTimer = setInterval(() => poll(getPolyMarkets()), KALSHI_POLL_MS);
}

export function stopKalshiMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getKalshiMarkets(): KalshiMarket[] {
  return kalshiMarkets;
}

export function getCrossPlatformOpps(): CrossPlatformOpp[] {
  return crossPlatformOpps;
}
