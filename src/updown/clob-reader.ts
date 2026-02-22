import { createLogger } from "../logger";
import { CLOB_API } from "./config";
import { UpDownMarket, OrderBookSummary, MarketPrices } from "./types";

const log = createLogger("clob-reader");

let clobErrors = 0;

export function getClobErrorCount(): number {
  return clobErrors;
}

// ─── CLOB order book reading (no auth required) ───

async function fetchOrderBook(tokenId: string): Promise<OrderBookSummary> {
  const url = `${CLOB_API}/book?token_id=${tokenId}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`CLOB book fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as any;

  // data.bids = [{price: "0.65", size: "100"}, ...], sorted desc
  // data.asks = [{price: "0.70", size: "50"}, ...], sorted asc
  const bids: Array<{ price: string; size: string }> = data.bids || [];
  const asks: Array<{ price: string; size: string }> = data.asks || [];

  const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
  const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;

  const midpoint = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  return {
    tokenId,
    bestBid,
    bestAsk,
    midpoint,
    spread,
  };
}

export async function getOrderBook(tokenId: string): Promise<OrderBookSummary> {
  try {
    return await fetchOrderBook(tokenId);
  } catch (e) {
    clobErrors++;
    if (clobErrors <= 5 || clobErrors % 50 === 0) {
      log.info("CLOB fetch failed", { tokenId: tokenId.slice(0, 20) + "...", error: (e as Error).message, totalErrors: clobErrors });
    }
    // Return a fallback with wide spread (arb-engine detects this and uses scanner prices)
    return {
      tokenId,
      bestBid: 0,
      bestAsk: 1,
      midpoint: 0.5,
      spread: 1,
    };
  }
}

export async function getBestPrices(market: UpDownMarket): Promise<MarketPrices> {
  const [yesBook, noBook] = await Promise.all([
    getOrderBook(market.yesTokenId),
    getOrderBook(market.noTokenId),
  ]);

  const combinedAsk = yesBook.bestAsk + noBook.bestAsk;

  log.debug("Market prices", {
    asset: market.asset,
    yesAsk: yesBook.bestAsk.toFixed(3),
    noAsk: noBook.bestAsk.toFixed(3),
    combined: combinedAsk.toFixed(3),
  });

  return { yesBook, noBook, combinedAsk };
}
