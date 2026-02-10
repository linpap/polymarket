import { PaperTrade, CalibrationBucket, PaperTradeState } from "./types";
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

export function generateReport(state: PaperTradeState): void {
  const resolved = state.trades.filter((t) => t.resolved);
  const unresolved = state.trades.filter((t) => !t.resolved);

  log.info("╔═══════════════════════════════════════════════════╗");
  log.info("║           PAPER TRADING REPORT                   ║");
  log.info("╚═══════════════════════════════════════════════════╝");

  // ─── Overview ───
  log.info("\n── Overview ──");
  log.info(`Running since: ${new Date(state.startedAt).toISOString()}`);
  log.info(`Cycles completed: ${state.cycleCount}`);
  log.info(`Total trades: ${state.trades.length}`);
  log.info(`Resolved: ${resolved.length} | Pending: ${unresolved.length}`);
  log.info(`API costs: $${state.totalApiCost.toFixed(4)}`);
  log.info(`Simulated bankroll: $${state.simulatedBankroll.toFixed(2)} (started: $${state.initialBankroll})`);

  if (resolved.length === 0) {
    log.info("\nNo resolved trades yet — check back after markets close.");
    printPendingTrades(unresolved);
    return;
  }

  // ─── P&L ───
  printPnl(resolved, state);

  // ─── Win rate ───
  printWinRate(resolved);

  // ─── Calibration ───
  printCalibration(resolved);

  // ─── Brier Score ───
  printBrierScore(resolved);

  // ─── Edge analysis ───
  printEdgeAnalysis(resolved);

  // ─── Pending trades ───
  if (unresolved.length > 0) {
    printPendingTrades(unresolved);
  }

  // ─── Trade log ───
  printResolvedTradeLog(resolved);
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
    log.info(
      `  ${t.side} $${t.hypotheticalSize.toFixed(2)} @ ${t.entryPrice.toFixed(2)} — "${t.question}" (${daysLeft}d left, ${(t.edge * 100).toFixed(0)}% edge)`
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
    log.info(
      `  [${tag}] ${t.side} @ ${t.entryPrice.toFixed(2)} → ${t.resolution} | P&L $${pnl.toFixed(2)} | "${t.question}"`
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
