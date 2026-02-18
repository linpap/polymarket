import { createLogger } from "../logger";
import { KALSHI_API, KALSHI_POLL_MS } from "./config";
import { KalshiMarket, CrossPlatformOpp, UpDownMarket } from "./types";

const log = createLogger("kalshi-monitor");

let kalshiMarkets: KalshiMarket[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
const crossPlatformOpps: CrossPlatformOpp[] = [];

// ─── Kalshi API ───

async function fetchKalshiCryptoMarkets(): Promise<KalshiMarket[]> {
  try {
    // Kalshi's public markets endpoint — filter for crypto
    const url = `${KALSHI_API}/markets?status=open&series_ticker=KXBTC&limit=50`;
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      // Try alternative endpoint patterns
      const altUrl = `${KALSHI_API}/markets?status=open&limit=100`;
      const altResp = await fetch(altUrl, { headers: { Accept: "application/json" } });

      if (!altResp.ok) {
        log.debug("Kalshi API returned non-OK", { status: altResp.status });
        return [];
      }

      const altData = await altResp.json() as any;
      const allMarkets = altData.markets || [];

      // Filter for crypto-related markets
      return allMarkets
        .filter((m: any) => {
          const title = (m.title || "").toLowerCase();
          return (
            title.includes("bitcoin") ||
            title.includes("btc") ||
            title.includes("ethereum") ||
            title.includes("eth") ||
            title.includes("crypto")
          );
        })
        .map(mapKalshiMarket);
    }

    const data = await resp.json() as any;
    return (data.markets || []).map(mapKalshiMarket);
  } catch (e) {
    log.debug("Kalshi fetch error (may be rate-limited or unavailable)", {
      error: (e as Error).message,
    });
    return [];
  }
}

function mapKalshiMarket(raw: any): KalshiMarket {
  return {
    ticker: raw.ticker || "",
    title: raw.title || raw.subtitle || "",
    category: raw.category || "",
    yes_ask: (raw.yes_ask || 0) / 100, // Kalshi uses cents
    no_ask: (raw.no_ask || 0) / 100,
    yes_bid: (raw.yes_bid || 0) / 100,
    no_bid: (raw.no_bid || 0) / 100,
    close_time: raw.close_time || raw.expiration_time || "",
    status: raw.status || "",
  };
}

// ─── Cross-platform comparison ───

export function findCrossPlatformArb(
  polyMarkets: UpDownMarket[]
): CrossPlatformOpp[] {
  const opps: CrossPlatformOpp[] = [];

  for (const kalshi of kalshiMarkets) {
    // Try to match Kalshi market to a Polymarket equivalent
    const kalshiTitle = kalshi.title.toLowerCase();

    for (const poly of polyMarkets) {
      // Simple matching: same asset and similar timeframe
      const assetMatch =
        (poly.asset === "BTC" && (kalshiTitle.includes("bitcoin") || kalshiTitle.includes("btc"))) ||
        (poly.asset === "ETH" && (kalshiTitle.includes("ethereum") || kalshiTitle.includes("eth"))) ||
        (poly.asset === "SOL" && kalshiTitle.includes("solana"));

      if (!assetMatch) continue;

      const polyYes = poly.currentYes;
      const kalshiYes = kalshi.yes_ask;
      const spread = Math.abs(polyYes - kalshiYes);

      if (spread > 0.05) {
        // Significant price difference
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
  kalshiMarkets = await fetchKalshiCryptoMarkets();

  if (kalshiMarkets.length > 0) {
    log.info("Kalshi crypto markets found", { count: kalshiMarkets.length });

    const opps = findCrossPlatformArb(polyMarkets);
    if (opps.length > 0) {
      for (const opp of opps) {
        log.info("CROSS-PLATFORM OPPORTUNITY", {
          poly: opp.polyMarket.question.slice(0, 60),
          kalshi: opp.kalshiMarket.title.slice(0, 60),
          polyYes: opp.polyYes.toFixed(3),
          kalshiYes: opp.kalshiYes.toFixed(3),
          spread: (opp.spread * 100).toFixed(1) + "%",
          direction: opp.direction,
        });
        crossPlatformOpps.push(opp);
      }
    }
  }
}

// ─── Public API ───

export function startKalshiMonitor(getPolyMarkets: () => UpDownMarket[]): void {
  log.info("Starting Kalshi monitor", { pollInterval: KALSHI_POLL_MS });
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
