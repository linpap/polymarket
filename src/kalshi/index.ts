import "dotenv/config";
import { createLogger } from "../logger";
import { KALSHI_TRADING } from "./config";
import { startFeed, stopFeed, hasPriceData, getAllPrices } from "../updown/binance-feed";
import { startScanner, stopScanner, getActiveMarkets } from "./scanner";
import { evaluateAllMarkets } from "./evaluator";
import {
  loadState, saveState, executePaperTrade, resolveExpired,
  recordScan, getStats, getBankroll, getOpenPositions,
} from "./paper-engine";

const log = createLogger("kalshi");

let running = false;

// ─── Status dashboard ───

function logStatus(): void {
  const stats = getStats();
  const bankroll = getBankroll();
  const open = getOpenPositions();
  const markets = getActiveMarkets();
  const prices = getAllPrices();

  const priceStr = Array.from(prices.entries())
    .map(([sym, bp]) =>
      `${sym.replace("usdt", "").toUpperCase()}: $${bp.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${bp.momentum})`
    )
    .join(" | ");

  const pnlSign = stats.totalPnl >= 0 ? "+" : "";

  console.log("\n" + "═".repeat(80));
  console.log("  KALSHI PAPER TRADING BOT — STATUS");
  console.log("═".repeat(80));
  console.log(`  Bankroll:      $${bankroll.toFixed(2)} (started $${KALSHI_TRADING.initialBankroll.toLocaleString()})`);
  console.log(`  Total P&L:     ${pnlSign}$${stats.totalPnl.toFixed(2)}`);
  console.log(`  Win Rate:      ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}W/${stats.losses}L of ${stats.totalTrades} trades)`);
  console.log(`  Open:          ${open.length} positions`);
  console.log(`  Active Mkts:   ${markets.length} eligible Kalshi markets`);
  console.log(`  Scanned:       ${stats.marketsScanned} total | ${stats.signalsGenerated} signals`);
  console.log("─".repeat(80));
  console.log(`  Prices: ${priceStr || "Waiting for Binance data..."}`);
  console.log("─".repeat(80));

  // Strategy breakdown
  for (const [strat, data] of Object.entries(stats.byStrategy)) {
    if (data.trades > 0) {
      const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(0) : "0";
      console.log(`  ${strat.padEnd(15)} ${data.trades} trades | ${wr}% WR | P&L: ${data.pnl >= 0 ? "+" : ""}$${data.pnl.toFixed(2)}`);
    }
  }

  // Category breakdown
  for (const [cat, data] of Object.entries(stats.byCategory)) {
    if (data.trades > 0) {
      const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(0) : "0";
      console.log(`  [${cat}]`.padEnd(17) + `${data.trades} trades | ${wr}% WR | P&L: ${data.pnl >= 0 ? "+" : ""}$${data.pnl.toFixed(2)}`);
    }
  }

  // Open positions
  if (open.length > 0) {
    console.log("─".repeat(80));
    console.log("  OPEN POSITIONS:");
    for (const pos of open) {
      const closeTime = new Date(pos.market.close_time).getTime();
      const hoursLeft = Math.max(0, (closeTime - Date.now()) / (1000 * 60 * 60));
      const timeStr = hoursLeft < 1
        ? `${Math.round(hoursLeft * 60)}m`
        : hoursLeft < 24
          ? `${hoursLeft.toFixed(1)}h`
          : `${(hoursLeft / 24).toFixed(1)}d`;
      console.log(`    ${pos.side.toUpperCase()} $${pos.size.toFixed(2)} @ ${(pos.entryPrice * 100).toFixed(0)}c | ${pos.strategy} | ${pos.market.title.slice(0, 45)} | ${timeStr} left`);
    }
  }

  console.log("═".repeat(80) + "\n");
}

// ─── Main loop ───

async function run(): Promise<void> {
  log.info("Starting Kalshi Paper Trading Bot", {
    bankroll: KALSHI_TRADING.initialBankroll,
    maxPosition: KALSHI_TRADING.maxPositionUsd,
    kellyFraction: KALSHI_TRADING.kellyFraction,
  });

  // Load persisted state
  loadState();

  // Start Binance feed for crypto-price strategy
  startFeed();

  // Wait for initial price data
  log.info("Waiting for Binance price data...");
  await waitForData(10_000);

  // Start Kalshi market scanner
  await startScanner();

  running = true;
  log.info("Bot is live — scanning Kalshi markets");

  // Main loop
  let lastStatusLog = 0;

  while (running) {
    try {
      // Resolve expired positions
      await resolveExpired();

      // Get current markets and evaluate
      const markets = getActiveMarkets();
      recordScan(markets.length);

      if (markets.length > 0) {
        const signals = await evaluateAllMarkets(markets);

        // Execute best signals (up to 3 per cycle to avoid overexposure)
        let executed = 0;
        for (const signal of signals) {
          if (executed >= 3) break;
          const trade = executePaperTrade(signal);
          if (trade) executed++;
        }
      }

      // Log status periodically
      if (Date.now() - lastStatusLog >= KALSHI_TRADING.statusLogIntervalMs) {
        logStatus();
        lastStatusLog = Date.now();
      }

      // Save state
      saveState();
    } catch (e) {
      log.error("Main loop error", (e as Error).message);
    }

    await sleep(KALSHI_TRADING.scanIntervalMs);
  }
}

function waitForData(timeoutMs: number): Promise<void> {
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
  log.info("Shutting down Kalshi bot...");
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

// ─── Entry point ───

run().catch((e) => {
  log.error("Fatal error", e);
  process.exit(1);
});
