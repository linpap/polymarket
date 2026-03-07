import { createLogger } from "../logger";
import { CLOB_API } from "../config";
import { Market, OrderBook, OrderBookLevel, MarketBooks } from "../types";

const log = createLogger("orderbook");

let fetchErrors = 0;

// ── Rate limiter: max 8 requests/sec to avoid 429s ──

const RATE_LIMIT_PER_SEC = 8;
let tokenBucket = RATE_LIMIT_PER_SEC;
let lastRefill = Date.now();

async function waitForToken(): Promise<void> {
  while (true) {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed >= 1000) {
      tokenBucket = RATE_LIMIT_PER_SEC;
      lastRefill = now;
    }
    if (tokenBucket > 0) {
      tokenBucket--;
      return;
    }
    // Wait until next refill
    await new Promise(r => setTimeout(r, Math.max(50, 1000 - elapsed)));
  }
}

/**
 * Fetch full order book depth for a token from Polymarket CLOB.
 * Returns all bid/ask levels, not just best prices.
 */
async function fetchBook(tokenId: string): Promise<OrderBook> {
  await waitForToken();

  const url = `${CLOB_API}/book?token_id=${tokenId}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`CLOB book fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as any;
  const rawBids: Array<{ price: string; size: string }> = data.bids || [];
  const rawAsks: Array<{ price: string; size: string }> = data.asks || [];

  // Parse and sort
  const bids: OrderBookLevel[] = rawBids
    .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
    .filter(b => b.size > 0)
    .sort((a, b) => b.price - a.price); // desc

  const asks: OrderBookLevel[] = rawAsks
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.size > 0)
    .sort((a, b) => a.price - b.price); // asc

  const bestBid = bids.length > 0 ? bids[0].price : 0;
  const bestAsk = asks.length > 0 ? asks[0].price : 1;
  const midpoint = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  // Depth: sum USD value of top 10 levels
  const bidDepthUsd = bids.slice(0, 10).reduce((sum, l) => sum + l.price * l.size, 0);
  const askDepthUsd = asks.slice(0, 10).reduce((sum, l) => sum + l.price * l.size, 0);

  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint,
    spread,
    bidDepthUsd,
    askDepthUsd,
    timestamp: Date.now(),
  };
}

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  try {
    return await fetchBook(tokenId);
  } catch (e) {
    fetchErrors++;
    if (fetchErrors <= 5 || fetchErrors % 100 === 0) {
      log.info("CLOB fetch failed", {
        tokenId: tokenId.slice(0, 20) + "...",
        error: (e as Error).message,
        totalErrors: fetchErrors,
      });
    }
    return {
      tokenId,
      bids: [],
      asks: [],
      bestBid: 0,
      bestAsk: 1,
      midpoint: 0.5,
      spread: 1,
      bidDepthUsd: 0,
      askDepthUsd: 0,
      timestamp: Date.now(),
    };
  }
}

export async function getMarketBooks(market: Market): Promise<MarketBooks> {
  // Sequential to respect rate limiter
  const yes = await getOrderBook(market.yesTokenId);
  const no = await getOrderBook(market.noTokenId);

  const combinedAsk = yes.bestAsk + no.bestAsk;

  log.debug("Market books", {
    id: market.marketId.slice(0, 12),
    yesAsk: yes.bestAsk.toFixed(3),
    noAsk: no.bestAsk.toFixed(3),
    combined: combinedAsk.toFixed(3),
    yesDepth: "$" + yes.askDepthUsd.toFixed(0),
    noDepth: "$" + no.askDepthUsd.toFixed(0),
  });

  return { yes, no, combinedAsk };
}
