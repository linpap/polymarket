import { PaperTrade, CalibrationBucket, PaperTradeState } from "./types";
import { categorizeMarket, MarketCategory } from "./analyzer";
import { createLogger } from "./logger";

const log = createLogger("reporter");

const BUCKET_RANGES = [
  { range: "0%-10%", lower: 0.0, upper: 0.1 },
  { range: "10%-20%", lower: 0.1, upper: 0.2 },
  { range: "20%-30%", lower: 0.2, upper: 0.3 },
  { range: "30%-40%", lower: 0.3, upper: 0.4 },
  { range: "40%-50%", lower: 0.4, upper: 0.5 },
  { range: "50%-60%", lower: 0.5, upper: 0.6 },
  { range: "60%-70%", lower: 0.6, upper: 0.7 },
  { range: "70%-80%", lower: 0.7, upper: 0.8 },
  { range: "80%-90%", lower: 0.8, upper: 0.9 },
  { range: "90%-100%", lower: 0.9, upper: 1.0 },
];

function shortName(model: string): string {
  if (model === "ensemble") return "ensemble";
  if (model.includes("deepseek")) return "deepseek";
  if (model.includes("gemma")) return "gemma";
  if (model.includes("hermes")) return "hermes";
  return model.split("/").pop()?.split(":")[0] || model;
}

export function generateReport(state: PaperTradeState): void {
  const resolved = state.trades.filter((t) => t.resolved);
  const unresolved = state.trades.filter((t) => !t.resolved);

  log.info("╔═══════════════════════════════════════════════════╗");
  log.info("║           MODEL HORSE RACE REPORT                ║");
  log.info("╚═══════════════════════════════════════════════════╝");

  // ─── Overview ───
  log.info("\n── Overview ──");
  log.info(`Running since: ${new Date(state.startedAt).toISOString()}`);
  log.info(`Cycles completed: ${state.cycleCount}`);
  log.info(`Total trades: ${state.trades.length}`);
  log.info(`Resolved: ${resolved.length} | Pending: ${unresolved.length}`);
  log.info(`API costs: $${state.totalApiCost.toFixed(4)}`);

  if (resolved.length === 0) {
    log.info("\nNo resolved trades yet — check back after markets close.");
    // ─── Model Leaderboard (pending) ───
    printModelLeaderboard(state);
    printPendingTrades(unresolved);
    return;
  }

  // ─── MODEL LEADERBOARD (the main event) ───
  printModelLeaderboard(state);

  // ─── P&L (all trades) ───
  printPnl(resolved, state);

  // ─── Win rate ───
  printWinRate(resolved);

  // ─── Calibration ───
  printCalibration(resolved);

  // ─── Brier Score ───
  printBrierScore(resolved);

  // ─── Market confirmation ───
  printMarketConfirmation(resolved, unresolved);

  // ─── Edge analysis ───
  printEdgeAnalysis(resolved);

  // ─── Category P&L ───
  printCategoryPnl(resolved);

  // ─── Pending trades ───
  if (unresolved.length > 0) {
    printPendingTrades(unresolved);
  }

  // ─── Trade log ───
  printResolvedTradeLog(resolved);
}

function printModelLeaderboard(state: PaperTradeState): void {
  log.info("\n══════════════════════════════════════");
  log.info("        MODEL LEADERBOARD");
  log.info("══════════════════════════════════════");
  log.info("");
  log.info("  Model      | Bankroll  | Trades | Resolved | Wins | Win%  | P&L      | Brier  | ROI");
  log.info("  -----------|-----------|--------|----------|------|-------|----------|--------|------");

  // Group trades by model
  const models = new Set<string>();
  for (const t of state.trades) {
    if (t.model) models.add(t.model);
  }

  const leaderboard: { model: string; pnl: number; bankroll: number; trades: number; resolved: number; wins: number; winPct: number; brier: number; roi: number }[] = [];

  for (const model of models) {
    const modelTrades = state.trades.filter((t) => t.model === model);
    const modelResolved = modelTrades.filter((t) => t.resolved);
    const modelPending = modelTrades.filter((t) => !t.resolved);
    const wins = modelResolved.filter((t) => (t.pnl ?? 0) > 0).length;
    const pnl = modelResolved.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const risked = modelResolved.reduce((s, t) => s + t.hypotheticalSize, 0);
    const roi = risked > 0 ? (pnl / risked) * 100 : 0;
    const winPct = modelResolved.length > 0 ? (wins / modelResolved.length) * 100 : 0;
    const bankroll = state.modelBankrolls?.[model] ?? 0;

    // Brier score
    let brierSum = 0;
    for (const t of modelResolved) {
      const outcome = t.resolution === "YES" ? 1 : 0;
      brierSum += (t.fairYes - outcome) ** 2;
    }
    const brier = modelResolved.length > 0 ? brierSum / modelResolved.length : 0;

    leaderboard.push({ model, pnl, bankroll, trades: modelTrades.length, resolved: modelResolved.length, wins, winPct, brier, roi });
  }

  // Sort by P&L descending
  leaderboard.sort((a, b) => b.pnl - a.pnl);

  for (const row of leaderboard) {
    const name = shortName(row.model).padEnd(11);
    const bankroll = ("$" + row.bankroll.toFixed(0)).padStart(9);
    const trades = String(row.trades).padStart(6);
    const resolved = String(row.resolved).padStart(8);
    const wins = String(row.wins).padStart(4);
    const winPct = (row.winPct.toFixed(0) + "%").padStart(5);
    const pnl = ("$" + (row.pnl >= 0 ? "+" : "") + row.pnl.toFixed(2)).padStart(8);
    const brier = row.resolved > 0 ? row.brier.toFixed(3).padStart(6) : "   N/A";
    const roi = row.resolved > 0 ? (row.roi.toFixed(1) + "%").padStart(6) : "   N/A";

    log.info(`  ${name}| ${bankroll} | ${trades} | ${resolved} | ${wins} | ${winPct} | ${pnl} | ${brier} | ${roi}`);
  }

  log.info("");

  // Head-to-head: how often do models agree?
  if (leaderboard.length > 1) {
    const resolved = state.trades.filter((t) => t.resolved);
    const marketIds = [...new Set(resolved.map((t) => t.marketId))];
    let agreeCount = 0;
    let disagreeCount = 0;

    for (const mid of marketIds) {
      const tradesOnMarket = resolved.filter((t) => t.marketId === mid);
      if (tradesOnMarket.length <= 1) continue;
      const sides = new Set(tradesOnMarket.map((t) => t.side));
      if (sides.size === 1) agreeCount++;
      else disagreeCount++;
    }

    if (agreeCount + disagreeCount > 0) {
      log.info(`  Head-to-head: Models agreed on ${agreeCount}/${agreeCount + disagreeCount} shared markets (${((agreeCount / (agreeCount + disagreeCount)) * 100).toFixed(0)}%)`);
      log.info(`  Disagreements: ${disagreeCount} markets where models picked different sides`);
    }
  }
}

function printPnl(resolved: PaperTrade[], state: PaperTradeState): void {
  log.info("\n── Hypothetical P&L ──");

  const totalPnl = resolved.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const totalRisked = resolved.reduce((sum, t) => sum + t.hypotheticalSize, 0);
  const roi = totalRisked > 0 ? (totalPnl / totalRisked) * 100 : 0;

  log.info(`Total P&L: $${totalPnl.toFixed(2)}`);
  log.info(`Total risked: $${totalRisked.toFixed(2)}`);
  log.info(`ROI: ${roi.toFixed(1)}%`);
  log.info(`Bankroll change: $${state.initialBankroll.toFixed(2)} → $${state.simulatedBankroll.toFixed(2)} (${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)})`);
}

function printWinRate(resolved: PaperTrade[]): void {
  log.info("\n── Win Rate ──");

  const wins = resolved.filter((t) => (t.pnl ?? 0) > 0);
  const losses = resolved.filter((t) => (t.pnl ?? 0) <= 0);
  const winRate = (wins.length / resolved.length) * 100;

  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length
    : 0;

  log.info(`Wins: ${wins.length} | Losses: ${losses.length}`);
  log.info(`Win rate: ${winRate.toFixed(1)}%`);
  log.info(`Avg win: +$${avgWin.toFixed(2)} | Avg loss: $${avgLoss.toFixed(2)}`);

  if (wins.length > 0 && losses.length > 0) {
    const profitFactor = Math.abs(
      wins.reduce((s, t) => s + (t.pnl ?? 0), 0) /
      losses.reduce((s, t) => s + (t.pnl ?? 0), 0)
    );
    log.info(`Profit factor: ${profitFactor.toFixed(2)}`);
  }
}

function printCalibration(resolved: PaperTrade[]): void {
  log.info("\n── Calibration ──");
  log.info("(Does our estimated probability match reality?)");
  log.info("");
  log.info("  Estimated    | Actual    | Count | Status");
  log.info("  -------------|-----------|-------|-------");

  const buckets = buildCalibrationBuckets(resolved);

  for (const bucket of buckets) {
    if (bucket.predictions === 0) continue;

    const expected = (bucket.expectedRate * 100).toFixed(0) + "%";
    const actual = bucket.actualRate !== null
      ? (bucket.actualRate * 100).toFixed(0) + "%"
      : "N/A";
    const diff = bucket.actualRate !== null
      ? Math.abs(bucket.actualRate - bucket.expectedRate)
      : 0;
    const status = bucket.actualRate === null
      ? ""
      : diff < 0.1
        ? "GOOD"
        : diff < 0.2
          ? "OK"
          : "MISCALIBRATED";

    log.info(
      `  ${bucket.range.padEnd(13)} | ${actual.padEnd(9)} | ${String(bucket.predictions).padEnd(5)} | ${status}`
    );
  }
}

function printBrierScore(resolved: PaperTrade[]): void {
  log.info("\n── Brier Score ──");
  log.info("(Lower is better. 0 = perfect, 0.25 = coin flip, 0.5 = always wrong)");

  // Brier score: mean of (forecast - outcome)^2
  // forecast = our fairYes estimate
  // outcome = 1 if YES resolved, 0 if NO resolved
  let brierSum = 0;

  for (const trade of resolved) {
    const outcome = trade.resolution === "YES" ? 1 : 0;
    const forecast = trade.fairYes;
    brierSum += (forecast - outcome) ** 2;
  }

  const brierScore = brierSum / resolved.length;

  // Also compute the market's Brier score for comparison
  let marketBrierSum = 0;
  for (const trade of resolved) {
    const outcome = trade.resolution === "YES" ? 1 : 0;
    const marketForecast = trade.marketPriceYes;
    marketBrierSum += (marketForecast - outcome) ** 2;
  }
  const marketBrier = marketBrierSum / resolved.length;

  log.info(`Our Brier score:     ${brierScore.toFixed(4)}`);
  log.info(`Market Brier score:  ${marketBrier.toFixed(4)}`);

  if (brierScore < marketBrier) {
    log.info(`Edge: Our predictions are ${((1 - brierScore / marketBrier) * 100).toFixed(1)}% better than the market`);
  } else if (brierScore > marketBrier) {
    log.info(`No edge: Market is ${((1 - marketBrier / brierScore) * 100).toFixed(1)}% better than our predictions`);
  } else {
    log.info(`Tied with the market`);
  }

  // Log loss
  let logLossSum = 0;
  let marketLogLossSum = 0;
  for (const trade of resolved) {
    const outcome = trade.resolution === "YES" ? 1 : 0;
    const f = Math.max(0.001, Math.min(0.999, trade.fairYes));
    const m = Math.max(0.001, Math.min(0.999, trade.marketPriceYes));
    logLossSum += -(outcome * Math.log(f) + (1 - outcome) * Math.log(1 - f));
    marketLogLossSum += -(outcome * Math.log(m) + (1 - outcome) * Math.log(1 - m));
  }

  log.info(`\nOur log loss:     ${(logLossSum / resolved.length).toFixed(4)}`);
  log.info(`Market log loss:  ${(marketLogLossSum / resolved.length).toFixed(4)}`);
}

function printMarketConfirmation(resolved: PaperTrade[], unresolved: PaperTrade[]): void {
  log.info("\n── Market Confirmation ──");
  log.info("(Did the market move TOWARD our estimate after entry?)");

  // For resolved trades: check if final price moved toward our fairYes
  const withHistory = resolved.filter((t) => t.priceHistory && t.priceHistory.length >= 2);

  if (withHistory.length > 0) {
    let confirmedCount = 0;
    let totalDrift = 0;

    for (const t of withHistory) {
      const entryYes = t.priceHistory![0].priceYes;
      // Use last recorded price before resolution
      const lastYes = t.priceHistory![t.priceHistory!.length - 1].priceYes;
      // Did market move toward our fairYes?
      const entryDistance = Math.abs(entryYes - t.fairYes);
      const lastDistance = Math.abs(lastYes - t.fairYes);
      const drift = entryDistance - lastDistance; // positive = toward us
      totalDrift += drift;
      if (drift > 0) confirmedCount++;
    }

    const confirmRate = (confirmedCount / withHistory.length) * 100;
    const avgDrift = totalDrift / withHistory.length;

    log.info(`Confirmation rate: ${confirmedCount}/${withHistory.length} (${confirmRate.toFixed(0)}%) of resolved trades moved TOWARD our estimate`);
    log.info(`Average price drift: ${avgDrift > 0 ? "+" : ""}${(avgDrift * 100).toFixed(2)}% toward our fair value`);

    if (confirmRate < 40) {
      log.info(`⚠ WARNING: <40% confirmation — market consistently moves AWAY from our estimates (likely negative edge)`);
    }
  } else {
    log.info("No resolved trades with price history yet");
  }

  // Show per-trade drift for pending trades
  const pendingWithHistory = unresolved.filter((t) => t.priceHistory && t.priceHistory.length >= 2);
  if (pendingWithHistory.length > 0) {
    log.info(`\n  Pending trade drift:`);
    for (const t of pendingWithHistory) {
      const entryYes = t.priceHistory![0].priceYes;
      const latestYes = t.priceHistory![t.priceHistory!.length - 1].priceYes;
      const entryDist = Math.abs(entryYes - t.fairYes);
      const nowDist = Math.abs(latestYes - t.fairYes);
      const drift = entryDist - nowDist;
      const dir = drift > 0 ? "TOWARD" : "AWAY ";
      log.info(
        `  ${dir} ${(drift * 100).toFixed(1).padStart(5)}% | ${t.side} "${t.question.slice(0, 50)}..." (${t.priceHistory!.length} snapshots)`
      );
    }
  }
}

function printEdgeAnalysis(resolved: PaperTrade[]): void {
  log.info("\n── Edge Analysis ──");
  log.info("(Did higher-edge trades perform better?)");

  // Split into high-edge (>15%) and moderate-edge (8-15%) buckets
  const highEdge = resolved.filter((t) => Math.abs(t.edge) >= 0.15);
  const modEdge = resolved.filter((t) => Math.abs(t.edge) < 0.15);

  for (const [label, group] of [["High edge (>15%)", highEdge], ["Moderate edge (8-15%)", modEdge]] as const) {
    if (group.length === 0) continue;
    const wins = group.filter((t) => (t.pnl ?? 0) > 0).length;
    const pnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0);
    log.info(`  ${label}: ${group.length} trades, ${((wins / group.length) * 100).toFixed(0)}% win rate, P&L $${pnl.toFixed(2)}`);
  }

  // By confidence
  log.info("");
  const highConf = resolved.filter((t) => t.confidence >= 0.65);
  const modConf = resolved.filter((t) => t.confidence < 0.65);

  for (const [label, group] of [["High confidence (>=65%)", highConf], ["Moderate confidence (<65%)", modConf]] as const) {
    if (group.length === 0) continue;
    const wins = group.filter((t) => (t.pnl ?? 0) > 0).length;
    const pnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0);
    log.info(`  ${label}: ${group.length} trades, ${((wins / group.length) * 100).toFixed(0)}% win rate, P&L $${pnl.toFixed(2)}`);
  }
}

function printCategoryPnl(resolved: PaperTrade[]): void {
  log.info("\n── Category P&L ──");
  log.info("(Performance by market type — use this to tune category multipliers)");
  log.info("");
  log.info("  Category   | Trades | Wins | Win%  | P&L      | Avg Edge");
  log.info("  -----------|--------|------|-------|----------|--------");

  // Group resolved trades by category
  const byCategory = new Map<MarketCategory, PaperTrade[]>();
  for (const t of resolved) {
    const cat = categorizeMarket(t.question);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(t);
  }

  // Sort categories by trade count descending
  const sorted = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [cat, trades] of sorted) {
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const pnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winPct = ((wins / trades.length) * 100).toFixed(0);
    const avgEdge = (trades.reduce((s, t) => s + Math.abs(t.edge), 0) / trades.length * 100).toFixed(1);

    log.info(
      `  ${cat.padEnd(11)}| ${String(trades.length).padEnd(6)} | ${String(wins).padEnd(4)} | ${(winPct + "%").padEnd(5)} | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2).padStart(7)} | ${avgEdge}%`
    );
  }
}

function printPendingTrades(unresolved: PaperTrade[]): void {
  log.info(`\n── Pending Trades (${unresolved.length}) ──`);

  // Sort by end date
  const sorted = [...unresolved].sort(
    (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
  );

  for (const t of sorted.slice(0, 20)) {
    const daysLeft = Math.ceil(
      (new Date(t.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    const modelTag = t.model ? `[${shortName(t.model)}] ` : "";
    log.info(
      `  ${modelTag}${t.side} $${t.hypotheticalSize.toFixed(2)} @ ${t.entryPrice.toFixed(2)} — "${t.question}" (${daysLeft}d left, ${(t.edge * 100).toFixed(0)}% edge)`
    );
  }

  if (sorted.length > 20) {
    log.info(`  ... and ${sorted.length - 20} more`);
  }
}

function printResolvedTradeLog(resolved: PaperTrade[]): void {
  log.info(`\n── Resolved Trade Log ──`);

  // Most recent first
  const sorted = [...resolved].sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));

  for (const t of sorted.slice(0, 30)) {
    const won = (t.pnl ?? 0) > 0;
    const tag = won ? "WIN " : "LOSS";
    const pnl = t.pnl ?? 0;
    const modelTag = t.model ? shortName(t.model) : "?";
    log.info(
      `  [${tag}] [${modelTag}] ${t.side} @ ${t.entryPrice.toFixed(2)} → ${t.resolution} | P&L $${pnl.toFixed(2)} | "${t.question}"`
    );
  }

  if (sorted.length > 30) {
    log.info(`  ... and ${sorted.length - 30} more`);
  }
}

function buildCalibrationBuckets(resolved: PaperTrade[]): CalibrationBucket[] {
  return BUCKET_RANGES.map((range) => {
    // For each trade, compute our implied probability of the side we picked
    // e.g., if we bet YES and fairYes=0.72, implied prob = 0.72
    //        if we bet NO and fairYes=0.30, implied prob = 0.70
    const inBucket = resolved.filter((t) => {
      const prob = t.side === "YES" ? t.fairYes : 1 - t.fairYes;
      return prob >= range.lower && prob < range.upper;
    });

    const won = inBucket.filter((t) => {
      return t.side === t.resolution;
    });

    let brierSum = 0;
    for (const t of inBucket) {
      const prob = t.side === "YES" ? t.fairYes : 1 - t.fairYes;
      const outcome = t.side === t.resolution ? 1 : 0;
      brierSum += (prob - outcome) ** 2;
    }

    return {
      range: range.range,
      lower: range.lower,
      upper: range.upper,
      predictions: inBucket.length,
      resolvedYes: won.length,
      actualRate: inBucket.length > 0 ? won.length / inBucket.length : null,
      expectedRate: (range.lower + range.upper) / 2,
      brierSum,
    };
  });
}
