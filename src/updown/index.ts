import "dotenv/config";
import { createLogger } from "../logger";
import { UPDOWN_TRADING } from "./config";
import { startFeed, stopFeed, hasPriceData, getAllPrices, onPriceMove } from "./binance-feed";
import { startScanner, stopScanner, getActiveMarkets, onNewMarket } from "./market-scanner";
import { evaluateMarket } from "./arbitrage-engine";
import { startKalshiMonitor, stopKalshiMonitor, getKalshiMarkets, getCrossPlatformOpps } from "./kalshi-monitor";
import {
  loadState, saveState, executePaperTrade, resolveExpired,
  recordOpportunity, getStats, getBankroll, getOpenPositions,
} from "./paper-engine";
import { UpDownMarket } from "./types";

const log = createLogger("updown");

let running = false;

// Track which markets we've already evaluated this cycle to avoid duplicates
const evaluatedThisCycle = new Set<string>();

// ─── Market evaluation ───

async function evaluateAllMarkets(): Promise<void> {
  const markets = getActiveMarkets();
  if (markets.length === 0) return;

  const crossOpps = getCrossPlatformOpps();

  for (const market of markets) {
    // Skip if already evaluated recently
    if (evaluatedThisCycle.has(market.marketId)) continue;
    evaluatedThisCycle.add(market.marketId);

    // Clear evaluated set periodically (every 15s to catch peak momentum)
    setTimeout(() => evaluatedThisCycle.delete(market.marketId), 15_000);

    try {
      const signal = await evaluateMarket(market, crossOpps);
      recordOpportunity(!!signal);

      if (signal) {
        const trade = executePaperTrade(signal);
        if (!trade) {
          log.debug("Trade rejected by paper engine");
        }
      }
    } catch (e) {
      log.error("Error evaluating market", {
        marketId: market.marketId,
        error: (e as Error).message,
      });
    }
  }
}

// ─── Status dashboard ───

function logStatus(): void {
  const stats = getStats();
  const bankroll = getBankroll();
  const openPositions = getOpenPositions();
  const activeMarkets = getActiveMarkets();
  const kalshiMarkets = getKalshiMarkets();
  const crossOpps = getCrossPlatformOpps();
  const prices = getAllPrices();

  // Build price summary
  const priceStr = Array.from(prices.entries())
    .map(([sym, bp]) => `${sym.replace("usdt", "").toUpperCase()}: $${bp.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${bp.momentum})`)
    .join(" | ");

  console.log("\n" + "═".repeat(80));
  console.log("  UP/DOWN TRADING BOT — STATUS");
  console.log("═".repeat(80));
  console.log(`  Bankroll:      $${bankroll.toFixed(2)} (started $${UPDOWN_TRADING.initialBankroll.toLocaleString()})`);
  console.log(`  Total P&L:     ${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}`);
  console.log(`  Win Rate:      ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}W/${stats.losses}L of ${stats.totalTrades} trades)`);
  console.log(`  Open:          ${openPositions.length} positions`);
  console.log(`  Active Mkts:   ${activeMarkets.length} Polymarket | ${kalshiMarkets.length} Kalshi`);
  console.log(`  Opportunities: ${stats.opportunitiesSeen} seen, ${stats.opportunitiesSkipped} skipped`);
  console.log(`  Cross-Plat:    ${crossOpps.length} opportunities logged`);
  console.log("─".repeat(80));
  console.log(`  Prices: ${priceStr || "Waiting for data..."}`);
  console.log("─".repeat(80));

  // Per-strategy breakdown
  for (const [strat, data] of Object.entries(stats.byStrategy)) {
    if (data.trades > 0) {
      const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(0) : "0";
      console.log(`  ${strat.padEnd(15)} ${data.trades} trades | ${wr}% WR | P&L: ${data.pnl >= 0 ? "+" : ""}$${data.pnl.toFixed(2)}`);
    }
  }

  // Open positions
  if (openPositions.length > 0) {
    console.log("─".repeat(80));
    console.log("  OPEN POSITIONS:");
    for (const pos of openPositions) {
      const timeLeft = Math.max(0, Math.round((pos.market.windowEnd - Date.now()) / 1000));
      console.log(`    ${pos.market.asset} ${pos.side} $${pos.size.toFixed(2)} | ${pos.strategy} | ${timeLeft}s remaining`);
    }
  }

  console.log("═".repeat(80) + "\n");
}

// ─── Main loop ───

async function run(): Promise<void> {
  log.info("Starting Up/Down Trading Bot", {
    bankroll: UPDOWN_TRADING.initialBankroll,
    maxPosition: UPDOWN_TRADING.maxPositionUsd,
  });

  // Load persisted state
  loadState();

  // Start components
  startFeed();
  startScanner();

  // Wait a moment for initial data
  log.info("Waiting for Binance price data...");
  await waitForPriceData(10_000);

  // Start Kalshi monitor (needs polymarket getter)
  startKalshiMonitor(getActiveMarkets);

  // Register event handlers
  onNewMarket(async (market: UpDownMarket) => {
    log.info("Evaluating new market immediately", {
      asset: market.asset,
      question: market.question.slice(0, 60),
    });
    try {
      const crossOpps = getCrossPlatformOpps();
      const signal = await evaluateMarket(market, crossOpps);
      recordOpportunity(!!signal);
      if (signal) executePaperTrade(signal);
    } catch (e) {
      log.error("Error on new market", (e as Error).message);
    }
  });

  onPriceMove(async (_symbol: string, _price) => {
    // Re-evaluate all active markets when price moves significantly
    await evaluateAllMarkets();
  });

  running = true;
  log.info("Bot is live — monitoring markets");

  // Main loop
  while (running) {
    try {
      // Resolve any expired positions
      resolveExpired();

      // Evaluate all active markets
      await evaluateAllMarkets();

      // Log status periodically
      logStatus();

      // Save state
      saveState();
    } catch (e) {
      log.error("Main loop error", (e as Error).message);
    }

    // Wait before next iteration
    await sleep(UPDOWN_TRADING.statusLogIntervalMs);
  }
}

function waitForPriceData(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Graceful shutdown ───

function shutdown(): void {
  log.info("Shutting down...");
  running = false;
  stopFeed();
  stopScanner();
  stopKalshiMonitor();
  saveState();
  logStatus();
  log.info("Goodbye!");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Entry point ───

run().catch((e) => {
  log.error("Fatal error", e);
  process.exit(1);
});
