import { createLogger } from "../logger";
import { TRADING } from "../config";
import { Market, MarketBooks, Signal } from "../types";

const log = createLogger("ob-imbalance");

/**
 * Order Book Imbalance: If 80%+ of order book volume is on the bid side,
 * the market is likely underpriced (buy pressure building, informed traders
 * accumulating before news).
 *
 * Works on all market types, not just crypto.
 */
export function evaluateOrderbookImbalance(
  market: Market,
  books: MarketBooks,
): Signal | null {
  // Need meaningful depth on both sides to compute ratio
  const yesTotalDepth = books.yes.bidDepthUsd + books.yes.askDepthUsd;
  const noTotalDepth = books.no.bidDepthUsd + books.no.askDepthUsd;

  if (yesTotalDepth < 100 && noTotalDepth < 100) return null; // too thin

  // Check YES token imbalance
  const yesSignal = checkImbalance(market, books, "yes");
  if (yesSignal) return yesSignal;

  // Check NO token imbalance
  const noSignal = checkImbalance(market, books, "no");
  if (noSignal) return noSignal;

  return null;
}

function checkImbalance(
  market: Market,
  books: MarketBooks,
  side: "yes" | "no",
): Signal | null {
  const book = side === "yes" ? books.yes : books.no;
  const totalDepth = book.bidDepthUsd + book.askDepthUsd;
  if (totalDepth < 100) return null;

  const bidRatio = book.bidDepthUsd / totalDepth;

  // Strong bid imbalance = market underpriced on this side
  if (bidRatio >= TRADING.imbalanceThreshold) {
    const action: "buy-yes" | "buy-no" = side === "yes" ? "buy-yes" : "buy-no";
    const askPrice = book.bestAsk;

    // Edge estimate: bid pressure implies fair value is higher than ask
    // Scale edge with imbalance strength
    const imbalanceStrength = (bidRatio - TRADING.imbalanceThreshold) / (1 - TRADING.imbalanceThreshold);
    const edge = 0.03 + imbalanceStrength * 0.07; // 3%-10% estimated edge

    if (edge < TRADING.imbalanceMinEdge) return null;

    const confidence = 0.40 + imbalanceStrength * 0.20; // 40%-60%

    log.info("OB imbalance signal", {
      id: market.marketId.slice(0, 12),
      side,
      bidRatio: (bidRatio * 100).toFixed(0) + "%",
      bidDepth: "$" + book.bidDepthUsd.toFixed(0),
      askDepth: "$" + book.askDepthUsd.toFixed(0),
      ask: askPrice.toFixed(3),
      edge: (edge * 100).toFixed(1) + "%",
    });

    return {
      strategy: "orderbook-imbalance",
      market,
      action,
      edge,
      confidence,
      reasoning: `OB imbalance: ${side.toUpperCase()} bids=${(bidRatio * 100).toFixed(0)}% of depth ` +
        `($${book.bidDepthUsd.toFixed(0)} bid / $${book.askDepthUsd.toFixed(0)} ask). ` +
        `${action} at ${askPrice.toFixed(3)}, est edge=${(edge * 100).toFixed(1)}%`,
    };
  }

  return null;
}
