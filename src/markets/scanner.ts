import { createLogger } from "../logger";
import { GAMMA_API, SCANNER_POLL_MS, TRADING } from "../config";
import { Market, MarketCategory } from "../types";

const log = createLogger("scanner");

let activeMarkets: Map<string, Market> = new Map();
let pollTimer: ReturnType<typeof setInterval> | null = null;
const newMarketCallbacks: Array<(market: Market) => void> = [];

// ── Asset detection from slug/question ──

const SLUG_ASSET_MAP: Record<string, string> = {
  btc: "BTC", bitcoin: "BTC",
  eth: "ETH", ethereum: "ETH",
  sol: "SOL", solana: "SOL",
  xrp: "XRP",
};

function parseAssetFromSlug(slug: string): string | null {
  const lower = slug.toLowerCase();
  for (const [key, ticker] of Object.entries(SLUG_ASSET_MAP)) {
    if (lower.startsWith(`${key}-updown`) || lower.startsWith(`${key}-up`)) {
      return ticker;
    }
  }
  return null;
}

function parseAssetFromQuestion(question: string): string | null {
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

function categorizeMarket(slug: string, question: string, asset: string | null): MarketCategory {
  if (asset && (slug.includes("updown") || question.toLowerCase().includes("up or down"))) {
    return "crypto-updown";
  }
  if (asset) return "crypto-price";

  const q = question.toLowerCase();
  if (q.includes("president") || q.includes("congress") || q.includes("election") || q.includes("trump") || q.includes("biden")) return "politics";
  if (q.includes("inflation") || q.includes("gdp") || q.includes("unemployment") || q.includes("fed") || q.includes("interest rate")) return "economics";
  if (q.includes("nba") || q.includes("nfl") || q.includes("mlb") || q.includes("goal") || q.includes("score")) return "sports";
  return "other";
}

// ── Parse event -> markets ──

function parseEventMarkets(event: any): Market[] {
  const results: Market[] = [];
  const eventSlug: string = event.slug || "";
  const eventMarkets: any[] = event.markets || [];

  for (const raw of eventMarkets) {
    try {
      const question: string = raw.question || event.title || "";
      const slug: string = raw.slug || eventSlug;
      const description: string = raw.description || event.description || "";

      const asset = parseAssetFromSlug(slug) || parseAssetFromQuestion(question);
      const category = categorizeMarket(slug, question, asset);

      // For crypto up/down, only track BTC, ETH, SOL
      if (category === "crypto-updown" && asset && !["BTC", "ETH", "SOL"].includes(asset)) continue;

      // Parse outcomes
      const outcomes: string[] = typeof raw.outcomes === "string"
        ? JSON.parse(raw.outcomes) : raw.outcomes || [];
      const prices: string[] = typeof raw.outcomePrices === "string"
        ? JSON.parse(raw.outcomePrices) : raw.outcomePrices || [];
      const tokenIds: string[] = typeof raw.clobTokenIds === "string"
        ? JSON.parse(raw.clobTokenIds) : raw.clobTokenIds || [];

      if (outcomes.length < 2 || prices.length < 2 || tokenIds.length < 2) continue;

      // Map Up/Down or Yes/No
      const upIdx = outcomes.findIndex((o: string) => /^up$/i.test(o));
      const downIdx = outcomes.findIndex((o: string) => /^down$/i.test(o));
      const yesIdx = upIdx !== -1 ? upIdx : outcomes.findIndex((o: string) => /^yes$/i.test(o));
      const noIdx = downIdx !== -1 ? downIdx : outcomes.findIndex((o: string) => /^(no|down)$/i.test(o));
      if (yesIdx === -1 || noIdx === -1) continue;

      // Parse timing
      const endDate = raw.endDate || event.endDate || "";
      const windowEnd = new Date(endDate).getTime();
      const windowType = parseWindowFromSlug(slug);
      const durationMs = windowType === "15m" ? 15 * 60 * 1000
        : windowType === "1h" ? 60 * 60 * 1000
        : 5 * 60 * 1000;
      const windowStart = windowEnd - durationMs;

      // Parse strike price
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
        category,
        asset: asset || undefined,
        direction: category === "crypto-updown" ? "up" : undefined,
        strikePrice: strikePrice || undefined,
        windowStart,
        windowEnd,
        currentYes: parseFloat(prices[yesIdx]) || 0.5,
        currentNo: parseFloat(prices[noIdx]) || 0.5,
        yesTokenId: tokenIds[yesIdx],
        noTokenId: tokenIds[noIdx],
        liquidity: parseFloat(raw.liquidity) || 0,
        active: isActive,
      });
    } catch {
      // skip malformed
    }
  }
  return results;
}

// ── Gamma API scanning ──

async function fetchCryptoUpDownMarkets(): Promise<Market[]> {
  const allMarkets: Market[] = [];
  const urls = [
    `${GAMMA_API}/events?tag=up-or-down&active=true&closed=false&limit=200&order=startDate&ascending=false`,
    `${GAMMA_API}/events?tag=up-or-down&active=true&closed=false&limit=200&order=endDate&ascending=true`,
    `${GAMMA_API}/events?tag=crypto&active=true&closed=false&limit=100&order=startDate&ascending=false`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const events = await resp.json() as any[];
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        allMarkets.push(...parseEventMarkets(event));
      }
    } catch (e) {
      log.debug("Gamma fetch error", { error: (e as Error).message });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return allMarkets.filter(m => {
    if (seen.has(m.marketId)) return false;
    seen.add(m.marketId);
    return true;
  });
}

async function fetchGeneralMarkets(): Promise<Market[]> {
  const allMarkets: Market[] = [];

  // Fetch popular / high-volume general markets
  const urls = [
    `${GAMMA_API}/events?active=true&closed=false&limit=100&order=liquidityNum&ascending=false`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const events = await resp.json() as any[];
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        const markets = parseEventMarkets(event);
        // Filter: not crypto-updown (already scanned), reasonable time horizon
        for (const m of markets) {
          if (m.category === "crypto-updown") continue;
          if (m.category === "sports") continue; // skip sports
          const hoursToClose = (m.windowEnd - Date.now()) / (1000 * 3600);
          if (hoursToClose < TRADING.generalMinHoursToClose) continue;
          if (hoursToClose > TRADING.generalMaxDaysToClose * 24) continue;
          allMarkets.push(m);
        }
      }
    } catch (e) {
      log.debug("General market fetch error", { error: (e as Error).message });
    }
  }

  const seen = new Set<string>();
  return allMarkets.filter(m => {
    if (seen.has(m.marketId)) return false;
    seen.add(m.marketId);
    return true;
  });
}

async function poll(): Promise<void> {
  try {
    const markets = await fetchCryptoUpDownMarkets();
    const now = Date.now();
    let newCount = 0;

    for (const market of markets) {
      if (market.windowEnd <= now || !market.active) continue;
      const existing = activeMarkets.get(market.marketId);
      if (!existing) {
        activeMarkets.set(market.marketId, market);
        newCount++;
        const timeLeft = Math.round((market.windowEnd - now) / 1000);
        log.info("New market", {
          cat: market.category,
          asset: market.asset,
          q: market.question.slice(0, 80),
          yes: market.currentYes.toFixed(3),
          no: market.currentNo.toFixed(3),
          expires: timeLeft + "s",
          liq: "$" + market.liquidity.toFixed(0),
        });
        for (const cb of newMarketCallbacks) {
          try { cb(market); } catch (e) { log.error("New market callback error", e); }
        }
      } else {
        existing.currentYes = market.currentYes;
        existing.currentNo = market.currentNo;
        existing.active = market.active;
      }
    }

    // Prune expired
    for (const [id, market] of activeMarkets) {
      if (market.windowEnd <= now || !market.active) {
        activeMarkets.delete(id);
      }
    }

    if (newCount > 0) {
      log.info("Scanner poll", { new: newCount, total: activeMarkets.size });
    }
  } catch (e) {
    log.error("Scanner poll error", e);
  }
}

let generalPollTimer: ReturnType<typeof setInterval> | null = null;

async function pollGeneral(): Promise<void> {
  try {
    const markets = await fetchGeneralMarkets();
    const now = Date.now();
    let newCount = 0;

    for (const market of markets) {
      if (activeMarkets.has(market.marketId)) continue;
      activeMarkets.set(market.marketId, market);
      newCount++;
      for (const cb of newMarketCallbacks) {
        try { cb(market); } catch (e) { log.error("New market callback error", e); }
      }
    }

    if (newCount > 0) {
      log.info("General poll", { new: newCount, total: activeMarkets.size });
    }
  } catch (e) {
    log.error("General poll error", e);
  }
}

// ── Public API ──

export function startScanner(): void {
  log.info("Starting market scanner", { cryptoPoll: SCANNER_POLL_MS, generalPoll: TRADING.generalMarketPollMs });
  poll();
  pollTimer = setInterval(poll, SCANNER_POLL_MS);
  // General markets polled less frequently
  setTimeout(() => {
    pollGeneral();
    generalPollTimer = setInterval(pollGeneral, TRADING.generalMarketPollMs);
  }, 5000);
}

export function stopScanner(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (generalPollTimer) { clearInterval(generalPollTimer); generalPollTimer = null; }
}

export function getActiveMarkets(): Market[] {
  return Array.from(activeMarkets.values());
}

export function getMarketById(id: string): Market | undefined {
  return activeMarkets.get(id);
}

export function onNewMarket(callback: (market: Market) => void): void {
  newMarketCallbacks.push(callback);
}
