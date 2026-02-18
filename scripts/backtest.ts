import "dotenv/config";
import axios from "axios";
import fs from "fs";
import path from "path";
import { GAMMA_API, CLOB_API, TRADING, ESTIMATION, CALIBRATION, STATE_DIR } from "../src/config";
import { GammaMarket } from "../src/types";
import { batchScreen, resetSessionCosts, getApiCostEstimate, deepAnalyze } from "../src/estimator";
import { filterStage1Candidates, evaluateSignal, categorizeMarket } from "../src/analyzer";
import { researchMarket } from "../src/research";
import { createLogger } from "../src/logger";

const log = createLogger("backtest");

// ─── Config from env ───
const MAX_MARKETS = parseInt(process.env.BACKTEST_MAX_MARKETS || "50", 10);
const USE_RESEARCH = process.env.BACKTEST_RESEARCH === "true";

interface BacktestPrediction {
  marketId: string;
  question: string;
  endDate: string;
  side: "YES" | "NO";
  fairYes: number;
  marketPriceYes: number;
  entryPrice: number;
  edge: number;
  confidence: number;
  informationBasis: string;
  category: string;
  // Filled in later when market resolves
  resolution?: "YES" | "NO";
  pnl?: number;
  correct?: boolean;
}

interface BacktestResult {
  runAt: string;
  mode: "active-snapshot";
  config: {
    maxMarkets: number;
    useResearch: boolean;
    shrinkage: number;
    edgeThreshold: number;
  };
  marketsScanned: number;
  marketsAnalyzed: number;
  predictionsGenerated: number;
  predictions: BacktestPrediction[];
  // Scored fields (filled in by --score mode)
  scored?: boolean;
  brierScore?: number;
  marketBrierScore?: number;
  winRate?: number;
  totalPnl?: number;
  apiCost: number;
}

/**
 * Fetch historical YES price from CLOB API for active markets.
 */
async function fetchCurrentPrice(tokenId: string): Promise<number | null> {
  try {
    const { data } = await axios.get(`${CLOB_API}/prices-history`, {
      params: { market: tokenId, interval: "max", fidelity: 60 },
    });
    const history = data.history || [];
    if (history.length === 0) return null;

    // Use most recent price
    return history[history.length - 1].p;
  } catch {
    return null;
  }
}

/**
 * Score existing predictions against resolved markets.
 */
async function scoreExistingResults(): Promise<void> {
  const resultsFile = path.join(STATE_DIR, "backtest-results.json");
  if (!fs.existsSync(resultsFile)) {
    log.info("No backtest results to score. Run backtest first.");
    return;
  }

  const result: BacktestResult = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
  const predictions = result.predictions;

  if (predictions.length === 0) {
    log.info("No predictions to score.");
    return;
  }

  log.info(`Scoring ${predictions.length} predictions...`);

  let scored = 0;
  for (const pred of predictions) {
    if (pred.resolution) continue; // already scored

    try {
      const { data } = await axios.get(`${GAMMA_API}/markets/${pred.marketId}`);
      if (!data || !data.closed) continue;

      const outcomePrices = JSON.parse(data.outcomePrices || "[]");
      const yesPrice = parseFloat(outcomePrices[0]);
      const noPrice = parseFloat(outcomePrices[1]);

      if (yesPrice > 0.95) {
        pred.resolution = "YES";
      } else if (noPrice > 0.95) {
        pred.resolution = "NO";
      } else {
        continue; // not cleanly resolved yet
      }

      pred.correct = pred.side === pred.resolution;
      const hypotheticalSize = TRADING.initialBankroll * 0.10;
      const shares = hypotheticalSize / pred.entryPrice;
      pred.pnl = pred.correct ? shares - hypotheticalSize : -hypotheticalSize;
      scored++;

      const tag = pred.correct ? "WIN " : "LOSS";
      log.info(`[${tag}] ${pred.side} "${pred.question.slice(0, 50)}..." → ${pred.resolution}`);
    } catch {
      continue;
    }
  }

  if (scored === 0) {
    log.info("No new resolutions found. Markets may not have resolved yet.");
    return;
  }

  // Compute aggregate metrics on resolved predictions
  const resolved = predictions.filter((p) => p.resolution);
  if (resolved.length > 0) {
    let brierSum = 0;
    let marketBrierSum = 0;
    for (const p of resolved) {
      const outcome = p.resolution === "YES" ? 1 : 0;
      brierSum += (p.fairYes - outcome) ** 2;
      marketBrierSum += (p.marketPriceYes - outcome) ** 2;
    }

    result.scored = true;
    result.brierScore = brierSum / resolved.length;
    result.marketBrierScore = marketBrierSum / resolved.length;
    result.winRate = resolved.filter((p) => p.correct).length / resolved.length * 100;
    result.totalPnl = resolved.reduce((s, p) => s + (p.pnl || 0), 0);

    log.info(`\n── Score Summary ──`);
    log.info(`Resolved: ${resolved.length}/${predictions.length}`);
    log.info(`Win rate: ${result.winRate.toFixed(0)}%`);
    log.info(`Our Brier:    ${result.brierScore.toFixed(4)}`);
    log.info(`Market Brier: ${result.marketBrierScore.toFixed(4)}`);
    if (result.brierScore < result.marketBrierScore) {
      log.info(`Edge: ${((1 - result.brierScore / result.marketBrierScore) * 100).toFixed(1)}% better than market`);
    } else {
      log.info(`No edge: market is ${((1 - result.marketBrierScore / result.brierScore) * 100).toFixed(1)}% better`);
    }
    log.info(`P&L: $${result.totalPnl >= 0 ? "+" : ""}${result.totalPnl.toFixed(2)}`);
  }

  fs.writeFileSync(resultsFile, JSON.stringify(result, null, 2));
  log.info(`\nUpdated ${resultsFile}`);
}

async function main() {
  // --score mode: score existing predictions
  if (process.argv.includes("--score")) {
    await scoreExistingResults();
    return;
  }

  log.info("╔═══════════════════════════════════════════════════╗");
  log.info("║       POLYMARKET BACKTEST v2                     ║");
  log.info("║       Snapshots active markets for scoring later ║");
  log.info("╚═══════════════════════════════════════════════════╝");
  log.info(`Max markets: ${MAX_MARKETS}`);
  log.info(`Research: ${USE_RESEARCH ? "ON" : "OFF"}`);
  log.info(`\nThis analyzes ACTIVE markets and records predictions.`);
  log.info(`Run "npm run backtest -- --score" later to check results.\n`);

  // 1. Scan active markets (same as paper trading)
  log.info("Scanning active markets...");
  const { scanMarkets } = await import("../src/scanner");
  const markets = await scanMarkets();
  if (markets.length === 0) {
    log.info("No active markets found");
    return;
  }

  const marketMap = new Map<string, GammaMarket>();
  for (const m of markets) marketMap.set(m.id, m);

  // 2. Stage 1: Batch screen
  log.info(`\n═══ STAGE 1: SCREENING ${markets.length} ACTIVE MARKETS ═══`);
  resetSessionCosts();
  const stage1 = await batchScreen(markets);
  log.info(`Stage 1 produced ${stage1.length} estimates`);

  // 3. Filter candidates
  const candidates = filterStage1Candidates(stage1);
  log.info(`${candidates.length} candidates pass Stage 1 filter`);

  if (candidates.length === 0) {
    log.info("No candidates — markets appear fairly priced.");
    log.info(`API cost: $${getApiCostEstimate().toFixed(4)}`);
    return;
  }

  // 4. Stage 2: Deep analysis (single model to save cost)
  log.info(`\n═══ STAGE 2: DEEP ANALYSIS ON ${candidates.length} CANDIDATES ═══`);
  const predictions: BacktestPrediction[] = [];

  for (const candidate of candidates) {
    const market = marketMap.get(candidate.marketId);
    if (!market) continue;

    const category = categorizeMarket(market.question);
    const currentYes = parseFloat(market.outcomePrices[0]);

    // Optional research
    let context: string | undefined;
    if (USE_RESEARCH) {
      context = await researchMarket(market.question, market.endDate, category);
    }

    const estimate = await deepAnalyze(market, currentYes, context || undefined);
    if (!estimate) continue;

    if (estimate.informationBasis === "speculative") {
      log.debug(`Skip speculative: "${market.question.slice(0, 50)}..."`);
      continue;
    }

    const signal = evaluateSignal(market, estimate, category);
    if (!signal) continue;

    predictions.push({
      marketId: market.id,
      question: market.question,
      endDate: market.endDate,
      side: signal.side,
      fairYes: signal.fairYes,
      marketPriceYes: currentYes,
      entryPrice: signal.marketPrice,
      edge: signal.edge,
      confidence: signal.confidence,
      informationBasis: signal.informationBasis,
      category,
    });

    log.info(`Prediction: ${signal.side} "${market.question.slice(0, 50)}..." | mkt: ${currentYes.toFixed(2)}, fair: ${signal.fairYes.toFixed(2)}, edge: ${(signal.edge * 100).toFixed(1)}%`);
  }

  const apiCost = getApiCostEstimate();

  // 5. Print summary
  log.info("\n╔═══════════════════════════════════════════════════╗");
  log.info("║           BACKTEST PREDICTIONS                   ║");
  log.info("╚═══════════════════════════════════════════════════╝");

  log.info(`\nMarkets scanned: ${markets.length}`);
  log.info(`Stage 1 candidates: ${candidates.length}`);
  log.info(`Predictions: ${predictions.length}`);
  log.info(`API cost: $${apiCost.toFixed(4)}`);

  if (predictions.length > 0) {
    log.info(`\nPredictions recorded:`);
    for (const p of predictions) {
      const daysLeft = Math.ceil((new Date(p.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      log.info(`  ${p.side} "${p.question.slice(0, 55)}..." | edge: ${(p.edge * 100).toFixed(1)}% | ${daysLeft}d left`);
    }
    log.info(`\nRun "npm run backtest -- --score" after markets resolve to check results.`);
  }

  // 6. Save
  const result: BacktestResult = {
    runAt: new Date().toISOString(),
    mode: "active-snapshot",
    config: {
      maxMarkets: MAX_MARKETS,
      useResearch: USE_RESEARCH,
      shrinkage: CALIBRATION.shrinkageFactor,
      edgeThreshold: TRADING.edgeThreshold,
    },
    marketsScanned: markets.length,
    marketsAnalyzed: candidates.length,
    predictionsGenerated: predictions.length,
    predictions,
    apiCost,
  };

  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  const resultsFile = path.join(STATE_DIR, "backtest-results.json");
  fs.writeFileSync(resultsFile, JSON.stringify(result, null, 2));
  log.info(`\nResults saved to ${resultsFile}`);
}

main().catch((err) => {
  log.error("Backtest failed", err);
  process.exit(1);
});
