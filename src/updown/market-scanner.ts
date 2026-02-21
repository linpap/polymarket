import { createLogger } from "../logger";
import { GAMMA_API, SCANNER_POLL_MS } from "./config";
import { UpDownMarket } from "./types";

const log = createLogger("market-scanner");

let activeMarkets: Map<string, UpDownMarket> = new Map();
let pollTimer: ReturnType<typeof setInterval> | null = null;
const newMarketCallbacks: Array<(market: UpDownMarket) => void> = [];

// ─── Slug-based asset detection ───
// Actual slug format: "btc-updown-5m-1771472400", "eth-updown-15m-1771471800"

const SLUG_ASSET_MAP: Record<string, string> = {
  btc: "BTC",
  bitcoin: "BTC",
  eth: "ETH",
  ethereum: "ETH",
  sol: "SOL",
  solana: "SOL",
  xrp: "XRP",
};

function parseAssetFromSlug(slug: string): string | null {
  const lower = slug.toLowerCase();
  for (const [key, ticker] of Object.entries(SLUG_ASSET_MAP)) {
    if (lower.startsWith(`${key}-updown`) || lower.startsWith(`${key}-up`)) {
      return ticker;
    }
  }
  // Fallback: parse from question "Bitcoin Up or Down - ..."
  return null;
}

function parseAssetFromQuestion(question: string): string | null {
  // Only match Up/Down style questions to avoid false positives
  // (e.g. "Netherlands" contains "eth")
  const q = question.toLowerCase();
  if (!q.includes("up or down") && !q.includes("up/down")) return null;
  if (q.includes("bitcoin") || q.includes("btc")) return "BTC";
  if (q.includes("ethereum") || q.includes("eth")) return "ETH";
  if (q.includes("solana") || q.includes("sol")) return "SOL";
  if (q.includes("xrp")) return "XRP";
  return null;
}

function parseWindowFromSlug(slug: string): "5m" | "15m" | "1h" | null {
  if (slug.includes("-5m-")) return "5m";
  if (slug.includes("-15m-")) return "15m";
  if (slug.includes("-1h-") || slug.includes("-hourly-")) return "1h";
  return null;
}

// ─── Parse event → markets ───

function parseEventMarkets(event: any): UpDownMarket[] {
  const results: UpDownMarket[] = [];
  const eventSlug: string = event.slug || "";
  const eventMarkets: any[] = event.markets || [];

  for (const raw of eventMarkets) {
    try {
      const question: string = raw.question || event.title || "";
      const slug: string = raw.slug || eventSlug;
      const description: string = raw.description || event.description || "";

      // Detect asset from slug or question
      const asset = parseAssetFromSlug(slug) || parseAssetFromQuestion(question);
      if (!asset) continue;

      // Only interested in BTC, ETH, SOL for now
      if (!["BTC", "ETH", "SOL"].includes(asset)) continue;

      // Parse outcomes: ["Up", "Down"] (not ["Yes", "No"])
      const outcomes: string[] = typeof raw.outcomes === "string"
        ? JSON.parse(raw.outcomes)
        : raw.outcomes || [];
      const prices: string[] = typeof raw.outcomePrices === "string"
        ? JSON.parse(raw.outcomePrices)
        : raw.outcomePrices || [];
      const tokenIds: string[] = typeof raw.clobTokenIds === "string"
        ? JSON.parse(raw.clobTokenIds)
        : raw.clobTokenIds || [];

      if (outcomes.length < 2 || prices.length < 2 || tokenIds.length < 2) continue;

      // Map Up/Down to Yes/No equivalents
      // "Up" = YES equivalent (price went up), "Down" = NO equivalent
      const upIdx = outcomes.findIndex((o: string) => /^up$/i.test(o));
      const downIdx = outcomes.findIndex((o: string) => /^down$/i.test(o));

      // Also handle traditional Yes/No if present
      const yesIdx = upIdx !== -1 ? upIdx : outcomes.findIndex((o: string) => /^yes$/i.test(o));
      const noIdx = downIdx !== -1 ? downIdx : outcomes.findIndex((o: string) => /^(no|down)$/i.test(o));

      if (yesIdx === -1 || noIdx === -1) continue;

      // Parse window timing
      // NOTE: API startDate is market CREATION time, not window start
      // Compute actual window start from endDate minus duration
      const endDate = raw.endDate || event.endDate || "";
      const windowEnd = new Date(endDate).getTime();
      const windowType = parseWindowFromSlug(slug);
      const durationMs = windowType === "15m" ? 15 * 60 * 1000
        : windowType === "1h" ? 60 * 60 * 1000
        : 5 * 60 * 1000; // default 5m
      const windowStart = windowEnd - durationMs;

      // Parse strike price from description if present
      let strikePrice = 0;
      const priceMatch = (question + " " + description).match(/\$[\d,]+(?:\.\d+)?/);
      if (priceMatch) {
        strikePrice = parseFloat(priceMatch[0].replace(/[$,]/g, ""));
      }

      const isActive = raw.active !== false && !raw.closed;

      results.push({
        marketId: String(raw.id),
        conditionId: raw.conditionId || "",
        question,
        slug,
        asset,
        direction: "up", // "Up" outcome = YES, always
        strikePrice,
        windowStart,
        windowEnd,
        currentYes: parseFloat(prices[yesIdx]) || 0.5,
        currentNo: parseFloat(prices[noIdx]) || 0.5,
        yesTokenId: tokenIds[yesIdx],
        noTokenId: tokenIds[noIdx],
        liquidity: parseFloat(raw.liquidity) || 0,
        active: isActive,
      });
    } catch (e) {
      // skip malformed market
    }
  }

  return results;
}

// ─── Gamma API scanning via /events endpoint ───

async function fetchUpDownMarkets(): Promise<UpDownMarket[]> {
  const allMarkets: UpDownMarket[] = [];

  // The Up/Down markets are discoverable via /events, not /markets
  // Need multiple queries: newest-created events (tomorrow's markets) AND
  // soonest-expiring events (tonight's markets about to expire that we can actually trade)
  const urls = [
    // Primary: newest up-or-down events (gets tomorrow's pipeline)
    `${GAMMA_API}/events?tag=up-or-down&active=true&closed=false&limit=200&order=startDate&ascending=false`,
    // Critical: soonest-expiring events — catches tonight's markets within trading window
    `${GAMMA_API}/events?tag=up-or-down&active=true&closed=false&limit=200&order=endDate&ascending=true`,
    // Fallback: crypto-tagged events
    `${GAMMA_API}/events?tag=crypto&active=true&closed=false&limit=100&order=startDate&ascending=false`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.debug("Gamma API returned non-OK", { url: url.split("?")[0], status: resp.status });
        continue;
      }
      const events = await resp.json() as any[];
      if (!Array.isArray(events)) continue;

      for (const event of events) {
        const markets = parseEventMarkets(event);
        allMarkets.push(...markets);
      }
    } catch (e) {
      log.debug("Gamma fetch error", { error: (e as Error).message });
    }
  }

  // Deduplicate by marketId
  const seen = new Set<string>();
  return allMarkets.filter((m) => {
    if (seen.has(m.marketId)) return false;
    seen.add(m.marketId);
    return true;
  });
}

async function poll(): Promise<void> {
  try {
    const markets = await fetchUpDownMarkets();
    const now = Date.now();

    let newCount = 0;
    for (const market of markets) {
      // Skip expired markets
      if (market.windowEnd <= now) continue;
      if (!market.active) continue;

      const existing = activeMarkets.get(market.marketId);
      if (!existing) {
        // New market discovered
        activeMarkets.set(market.marketId, market);
        newCount++;
        const timeLeft = Math.round((market.windowEnd - now) / 1000);
        log.info("New Up/Down market", {
          asset: market.asset,
          question: market.question.slice(0, 80),
          yesPrice: market.currentYes.toFixed(3),
          noPrice: market.currentNo.toFixed(3),
          expiresIn: timeLeft + "s",
          liquidity: "$" + market.liquidity.toFixed(0),
        });
        for (const cb of newMarketCallbacks) {
          try {
            cb(market);
          } catch (e) {
            log.error("New market callback error", e);
          }
        }
      } else {
        // Update prices
        existing.currentYes = market.currentYes;
        existing.currentNo = market.currentNo;
        existing.active = market.active;
      }
    }

    // Prune expired markets
    for (const [id, market] of activeMarkets) {
      if (market.windowEnd <= now || !market.active) {
        activeMarkets.delete(id);
      }
    }

    if (newCount > 0) {
      log.info("Scanner poll complete", {
        newMarkets: newCount,
        totalActive: activeMarkets.size,
      });
    }
  } catch (e) {
    log.error("Scanner poll error", e);
  }
}

// ─── Public API ───

export function startScanner(): void {
  log.info("Starting market scanner", { pollInterval: SCANNER_POLL_MS });
  poll(); // immediate first poll
  pollTimer = setInterval(poll, SCANNER_POLL_MS);
}

export function stopScanner(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getActiveMarkets(): UpDownMarket[] {
  return Array.from(activeMarkets.values());
}

export function onNewMarket(callback: (market: UpDownMarket) => void): void {
  newMarketCallbacks.push(callback);
}

export function getMarketById(marketId: string): UpDownMarket | undefined {
  return activeMarkets.get(marketId);
}
