import "dotenv/config";
import { createLogger } from "./logger";
import { TRADING } from "./config";
import { startFeed, stopFeed, hasPriceData, getAllPrices, onPriceMove } from "./feeds/coinbase";
import { startScanner, stopScanner, getActiveMarkets, onNewMarket } from "./markets/scanner";
import { evaluateMarket, getSkipReasons } from "./strategies/index";
import {
  loadState, saveState, executePaperTrade, resolveExpired,
  recordOpportunity, getStats, getBankroll, getOpenPositions,
} from "./engine/paper-engine";
import { Market } from "./types";

const log = createLogger("bot");

let running = false;
const evaluatedThisCycle = new Set<string>();

// ── Market evaluation ──

async function evaluateAllMarkets(): Promise<void> {
  const markets = getActiveMarkets();
  if (markets.length === 0) return;

  for (const market of markets) {
    if (evaluatedThisCycle.has(market.marketId)) continue;
    evaluatedThisCycle.add(market.marketId);
    setTimeout(() => evaluatedThisCycle.delete(market.marketId), 10_000);

    try {
      const signal = await evaluateMarket(market);
      recordOpportunity(!!signal);

      if (signal) {
        const trade = await executePaperTrade(signal);
        if (!trade) {
          log.debug("Trade rejected by engine");
        }
      }
    } catch (e) {
      log.error("Error evaluating market", {
        id: market.marketId,
        error: (e as Error).message,
      });
    }
  }
}

// ── Status dashboard ──

function logStatus(): void {
  const stats = getStats();
  const bankroll = getBankroll();
  const openPositions = getOpenPositions();
  const activeMarkets = getActiveMarkets();
  const prices = getAllPrices();

  const priceStr = Array.from(prices.entries())
    .map(([sym, cp]) => {
      const ticker = sym.replace("usdt", "").toUpperCase();
      return `${ticker}: $${cp.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${cp.momentum}, vol=${(cp.realizedVol * 100).toFixed(0)}%)`;
    })
    .join(" | ");

  const cryptoMarkets = activeMarkets.filter(m => m.category === "crypto-updown").length;
  const generalMarkets = activeMarkets.length - cryptoMarkets;

  console.log("\n" + "=".repeat(85));
  console.log("  POLYMARKET PAPER TRADING BOT");
  console.log("=".repeat(85));
  console.log(`  Bankroll:      $${bankroll.toFixed(2)} (started $${TRADING.initialBankroll.toLocaleString()})`);
  console.log(`  Total P&L:     ${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}`);
  console.log(`  Win Rate:      ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}W/${stats.losses}L of ${stats.totalTrades} trades)`);
  console.log(`  Open:          ${openPositions.length} positions`);
  console.log(`  Markets:       ${cryptoMarkets} crypto | ${generalMarkets} general`);
  console.log(`  Opportunities: ${stats.opportunitiesSeen} seen, ${stats.opportunitiesSkipped} skipped`);
  console.log("-".repeat(85));
  console.log(`  Prices: ${priceStr || "Waiting for data..."}`);
  console.log("-".repeat(85));

  // Skip reasons
  const reasons = getSkipReasons();
  const reasonEntries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  if (reasonEntries.length > 0) {
    const top5 = reasonEntries.slice(0, 5).map(([r, n]) => `${r}:${n}`).join(", ");
    console.log(`  Skip reasons: ${top5}`);
  }

  // Per-strategy breakdown
  for (const [strat, data] of Object.entries(stats.byStrategy)) {
    if (data.trades > 0) {
      const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(0) : "0";
      console.log(`  ${strat.padEnd(20)} ${data.trades} trades | ${wr}% WR | P&L: ${data.pnl >= 0 ? "+" : ""}$${data.pnl.toFixed(2)}`);
    }
  }

  // Open positions
  if (openPositions.length > 0) {
    console.log("-".repeat(85));
    console.log("  OPEN POSITIONS:");
    for (const pos of openPositions) {
      const timeLeft = Math.max(0, Math.round((pos.market.windowEnd - Date.now()) / 1000));
      const assetLabel = pos.market.asset || pos.market.category;
      console.log(`    ${assetLabel} ${pos.side} $${pos.size.toFixed(2)} | ${pos.strategy} | ${timeLeft}s remaining | vwap=${pos.vwapEntry.toFixed(4)}`);
    }
  }

  console.log("=".repeat(85) + "\n");
}

// ── Main loop ──

async function run(): Promise<void> {
  log.info("Starting Polymarket Paper Trading Bot", {
    bankroll: TRADING.initialBankroll,
    maxPosition: TRADING.maxPositionUsd,
    maxOpen: TRADING.maxOpenPositions,
    strategies: "complete-set, vol-fair, latency, ob-imbalance, llm-fair",
  });

  loadState();
  startFeed();
  startScanner();

  log.info("Waiting for Coinbase price data...");
  await waitForPriceData(10_000);

  // Queue new markets for evaluation
  const pendingNew: Market[] = [];
  let processingNew = false;

  onNewMarket((market: Market) => {
    pendingNew.push(market);
    processNewMarkets();
  });

  async function processNewMarkets(): Promise<void> {
    if (processingNew) return;
    processingNew = true;
    while (pendingNew.length > 0) {
      const market = pendingNew.shift()!;
      try {
        const signal = await evaluateMarket(market);
        recordOpportunity(!!signal);
        if (signal) await executePaperTrade(signal);
      } catch (e) {
        log.error("Error on new market", (e as Error).message);
      }
    }
    processingNew = false;
  }

  onPriceMove(async () => {
    await evaluateAllMarkets();
  });

  running = true;
  log.info("Bot is live - monitoring markets");

  while (running) {
    try {
      resolveExpired();
      await evaluateAllMarkets();
      logStatus();
      saveState();
    } catch (e) {
      log.error("Main loop error", (e as Error).message);
    }
    await sleep(TRADING.statusLogIntervalMs);
  }
}

function waitForPriceData(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      if (hasPriceData() || Date.now() - start > timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Graceful shutdown ──

function shutdown(): void {
  log.info("Shutting down...");
  running = false;
  stopFeed();
  stopScanner();
  saveState();
  logStatus();
  log.info("Goodbye!");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run().catch(e => {
  log.error("Fatal error", e);
  process.exit(1);
});
