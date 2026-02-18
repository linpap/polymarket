import { createLogger } from "../logger";
import { KALSHI_API, KALSHI_RATE_LIMIT_MS } from "./config";
import { KalshiMarket } from "./types";

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

function mapMarket(raw: any, eventCategory?: string, eventTitle?: string): KalshiMarket {
  return {
    ticker: raw.ticker || "",
    event_ticker: raw.event_ticker || "",
    series_ticker: raw.series_ticker || "",
    title: raw.title || eventTitle || "",
    subtitle: raw.subtitle || "",
    category: eventCategory || raw.category || "",
    yes_ask: (raw.yes_ask || 0) / 100,   // cents → 0-1
    no_ask: (raw.no_ask || 0) / 100,
    yes_bid: (raw.yes_bid || 0) / 100,
    no_bid: (raw.no_bid || 0) / 100,
    last_price: (raw.last_price || 0) / 100,
    volume: raw.volume || 0,
    volume_24h: raw.volume_24h || 0,
    open_interest: raw.open_interest || 0,
    close_time: raw.close_time || raw.expiration_time || "",
    result: raw.result || raw.expiration_value || "",
    status: raw.status || "",
  };
}

// ─── Fetch markets via events endpoint (carries category) ───

export async function fetchOpenMarkets(limit = 500): Promise<KalshiMarket[]> {
  const all: KalshiMarket[] = [];
  let cursor = "";

  try {
    do {
      const params = new URLSearchParams({
        status: "open",
        with_nested_markets: "true",
        limit: String(Math.min(limit - all.length, 50)),
      });
      if (cursor) params.set("cursor", cursor);

      const data = await kalshiFetch(`/events?${params}`);
      const events = data.events || [];

      for (const event of events) {
        const category = event.category || "";
        const eventTitle = event.title || "";
        const markets = event.markets || [];
        for (const m of markets) {
          all.push(mapMarket(m, category, eventTitle));
        }
      }

      cursor = data.cursor || "";
      if (events.length < 50 || all.length >= limit) break;
    } while (cursor);
  } catch (e) {
    log.debug("Failed to fetch open markets", (e as Error).message);
  }

  log.debug("Fetched markets", { total: all.length });
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
