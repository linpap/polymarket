import { createLogger } from "../logger";
import { KALSHI_API, KALSHI_RATE_LIMIT_MS } from "./config";
import { KalshiMarket, KalshiRawMarket, KalshiMarketsResponse } from "./types";

const log = createLogger("kalshi-api");

let lastCallTime = 0;

// ─── Rate limiting ───

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < KALSHI_RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, KALSHI_RATE_LIMIT_MS - elapsed));
  }
  lastCallTime = Date.now();
}

// ─── Raw fetch with error handling ───

async function kalshiFetch(path: string): Promise<any> {
  await rateLimit();
  const url = `${KALSHI_API}${path}`;
  log.debug("Fetching", { url });

  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    log.debug("Kalshi API error", { status: resp.status, body: body.slice(0, 200) });
    throw new Error(`Kalshi API ${resp.status}: ${body.slice(0, 100)}`);
  }

  return resp.json();
}

// ─── Convert raw market to our type ───

function mapMarket(raw: KalshiRawMarket): KalshiMarket {
  return {
    ticker: raw.ticker || "",
    event_ticker: raw.event_ticker || "",
    series_ticker: raw.series_ticker || "",
    title: raw.title || "",
    subtitle: raw.subtitle || "",
    category: raw.category || "",
    yes_ask: (raw.yes_ask || 0) / 100,   // cents → 0-1
    no_ask: (raw.no_ask || 0) / 100,
    yes_bid: (raw.yes_bid || 0) / 100,
    no_bid: (raw.no_bid || 0) / 100,
    last_price: (raw.last_price || 0) / 100,
    volume: raw.volume || 0,
    volume_24h: raw.volume_24h || 0,
    open_interest: raw.open_interest || 0,
    close_time: raw.close_time || "",
    result: raw.result || "",
    status: raw.status || "",
  };
}

// ─── Fetch markets with pagination ───

export async function fetchMarketsBySeries(seriesTicker: string): Promise<KalshiMarket[]> {
  const all: KalshiMarket[] = [];
  let cursor = "";
  const limit = 100;

  try {
    do {
      const params = new URLSearchParams({
        series_ticker: seriesTicker,
        status: "open",
        limit: String(limit),
      });
      if (cursor) params.set("cursor", cursor);

      const data: KalshiMarketsResponse = await kalshiFetch(`/markets?${params}`);
      const markets = (data.markets || []).map(mapMarket);
      all.push(...markets);

      cursor = data.cursor || "";
      // Stop if we got fewer than limit (last page)
      if (markets.length < limit) break;
    } while (cursor);
  } catch (e) {
    log.debug(`Failed to fetch series ${seriesTicker}`, (e as Error).message);
  }

  return all;
}

// ─── Fetch all open markets (broad scan) ───

export async function fetchOpenMarkets(limit = 200): Promise<KalshiMarket[]> {
  const all: KalshiMarket[] = [];
  let cursor = "";

  try {
    do {
      const params = new URLSearchParams({
        status: "open",
        limit: String(Math.min(limit - all.length, 100)),
      });
      if (cursor) params.set("cursor", cursor);

      const data: KalshiMarketsResponse = await kalshiFetch(`/markets?${params}`);
      const markets = (data.markets || []).map(mapMarket);
      all.push(...markets);

      cursor = data.cursor || "";
      if (markets.length < 100 || all.length >= limit) break;
    } while (cursor);
  } catch (e) {
    log.debug("Failed to fetch open markets", (e as Error).message);
  }

  return all;
}

// ─── Fetch a single market (for resolution checking) ───

export async function fetchMarket(ticker: string): Promise<KalshiMarket | null> {
  try {
    const data = await kalshiFetch(`/markets/${ticker}`);
    const raw = data.market || data;
    return mapMarket(raw);
  } catch (e) {
    log.debug(`Failed to fetch market ${ticker}`, (e as Error).message);
    return null;
  }
}

// ─── Fetch event markets (all markets under one event) ───

export async function fetchEventMarkets(eventTicker: string): Promise<KalshiMarket[]> {
  try {
    const params = new URLSearchParams({
      event_ticker: eventTicker,
      limit: "100",
    });
    const data: KalshiMarketsResponse = await kalshiFetch(`/markets?${params}`);
    return (data.markets || []).map(mapMarket);
  } catch (e) {
    log.debug(`Failed to fetch event ${eventTicker}`, (e as Error).message);
    return [];
  }
}
