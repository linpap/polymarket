import fs from "fs";
import path from "path";
import { TRADING, ESTIMATION, STATE_DIR } from "./config";
import { GammaMarket, PaperTrade, PaperTradeState } from "./types";
import { scanMarkets, fetchMarketById } from "./scanner";
import { batchScreen, getApiCostEstimate, resetSessionCosts } from "./estimator";
import { filterStage1Candidates, analyzeMarkets, prioritizeMarkets } from "./analyzer";
import { getResearchCostEstimate, resetResearchCosts } from "./research";
import { sizePositions } from "./sizer";
import { checkResolutions, flagExpiredUnresolved } from "./resolver";
import { generateReport } from "./reporter";
import { createLogger } from "./logger";

const log = createLogger("paper-trader");

const PAPER_STATE_FILE = path.join(STATE_DIR, "paper-trades.json");

function getNextMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function shortName(model: string): string {
  if (model === "ensemble") return "ensemble";
  if (model.includes("deepseek")) return "deepseek";
  if (model.includes("gemma")) return "gemma";
  if (model.includes("hermes")) return "hermes";
  return model.split("/").pop()?.split(":")[0] || model;
}

const DEFAULT_STATE: PaperTradeState = {
  startedAt: Date.now(),
  lastCycleAt: 0,
  cycleCount: 0,
  simulatedBankroll: TRADING.initialBankroll,
  initialBankroll: TRADING.initialBankroll,
  trades: [],
  totalApiCost: 0,
  dailyApiCost: 0,
  dailyApiCostResetAt: getNextMidnight(),
  modelBankrolls: {},
};

/** Initialize per-model bankrolls if not present (includes ensemble) */
function ensureModelBankrolls(state: PaperTradeState): void {
  if (!state.modelBankrolls) {
    state.modelBankrolls = {};
  }
  const allModels = [...ESTIMATION.ensembleModels, "ensemble"];
  for (const model of allModels) {
    if (state.modelBankrolls[model] === undefined) {
      state.modelBankrolls[model] = TRADING.initialBankroll;
      log.info(`Initialized bankroll for ${shortName(model)}: $${TRADING.initialBankroll}`);
    }
  }
}

export function loadPaperState(): PaperTradeState {
  try {
    if (fs.existsSync(PAPER_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PAPER_STATE_FILE, "utf-8"));
      log.info("Loaded paper trade state", {
        cycles: data.cycleCount,
        trades: data.trades?.length || 0,
        bankroll: data.simulatedBankroll,
      });
      return data as PaperTradeState;
    }
  } catch (err) {
    log.error("Failed to load paper state, using defaults", err);
  }
  return { ...DEFAULT_STATE, startedAt: Date.now() };
}

export function savePaperState(state: PaperTradeState): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(PAPER_STATE_FILE, JSON.stringify(state, null, 2));
  log.debug("Paper trade state saved");
}

export async function runPaperCycle(state: PaperTradeState): Promise<void> {
  log.info(`═══ PAPER CYCLE #${state.cycleCount + 1} ═══`);
  log.info(`Models competing: ${ESTIMATION.ensembleModels.map(shortName).join(" vs ")}`);

  ensureModelBankrolls(state);

  // 1. Check API budget
  if (Date.now() > state.dailyApiCostResetAt) {
    state.dailyApiCost = 0;
    state.dailyApiCostResetAt = getNextMidnight();
  }

  if (state.dailyApiCost >= TRADING.dailyApiCap) {
    log.warn("Daily API budget exceeded, skipping estimation this cycle");
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    savePaperState(state);
    return;
  }

  // 2. Check resolutions on existing trades
  if (state.trades.length > 0) {
    log.info("Checking resolutions...");
    state.trades = await checkResolutions(state.trades);

    const justResolved = state.trades.filter(
      (t) => t.resolved && t.resolvedAt && Date.now() - t.resolvedAt < TRADING.cycleIntervalMs * 2
    );
    for (const t of justResolved) {
      if (t.pnl !== null && t.model && state.modelBankrolls) {
        state.modelBankrolls[t.model] = (state.modelBankrolls[t.model] || 0) + t.pnl;
        state.simulatedBankroll += t.pnl;
        const tag = t.pnl > 0 ? "WIN" : "LOSS";
        log.info(
          `[${shortName(t.model)}] [${tag}] "${t.question}" — ${t.side} resolved ${t.resolution}, P&L: $${t.pnl.toFixed(2)}`
        );
      }
    }

    flagExpiredUnresolved(state.trades);
  }

  // 2b. Track price movement on pending trades
  const pendingTrades = state.trades.filter((t) => !t.resolved);
  if (pendingTrades.length > 0) {
    log.info(`Tracking prices on ${pendingTrades.length} pending trades...`);
    for (const trade of pendingTrades) {
      const freshMarket = await fetchMarketById(trade.marketId);
      if (!freshMarket) continue;

      const currentYes = parseFloat(freshMarket.outcomePrices[0]);

      if (!trade.priceHistory) {
        trade.priceHistory = [{ timestamp: trade.timestamp, priceYes: trade.marketPriceYes }];
      }

      trade.priceHistory.push({ timestamp: Date.now(), priceYes: currentYes });

      const entryYes = trade.marketPriceYes;
      const drift = currentYes - entryYes;
      const fairDrift = Math.abs(currentYes - trade.fairYes) - Math.abs(entryYes - trade.fairYes);
      const direction = fairDrift < 0 ? "TOWARD" : "AWAY";

      log.info(
        `  [${shortName(trade.model || "?")}] ${direction}: "${trade.question.slice(0, 50)}..." — entry ${entryYes.toFixed(3)} → now ${currentYes.toFixed(3)} (drift ${drift > 0 ? "+" : ""}${(drift * 100).toFixed(1)}%)`
      );
    }
  }

  // 3. Scan markets
  log.info("Scanning markets...");
  const markets = await scanMarkets();
  if (markets.length === 0) {
    log.warn("No markets found");
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    savePaperState(state);
    return;
  }

  const prioritized = prioritizeMarkets(markets);

  // 3b. Pre-filter for free tier: pick ~40 markets with most extreme prices
  // Free models are best at obvious mispricings (extreme prices far from 0.50)
  const MAX_STAGE1_MARKETS = 40;
  const preFiltered = prioritized
    .map((m) => ({ m, yesPrice: parseFloat(m.outcomePrices[0]) }))
    .filter(({ yesPrice }) => yesPrice > 0.01 && yesPrice < 0.99)
    .sort((a, b) => {
      // Most extreme prices first (furthest from 0.50)
      const distA = Math.abs(a.yesPrice - 0.50);
      const distB = Math.abs(b.yesPrice - 0.50);
      return distB - distA;
    })
    .slice(0, MAX_STAGE1_MARKETS)
    .map(({ m }) => m);

  log.info(`Pre-filtered: ${prioritized.length} → ${preFiltered.length} markets (most extreme prices)`);

  const marketMap = new Map<string, GammaMarket>();
  for (const m of preFiltered) marketMap.set(m.id, m);

  // 4. Stage 1: Batch screen
  resetSessionCosts();
  resetResearchCosts();
  log.info(`Stage 1: Screening ${preFiltered.length} markets...`);
  const stage1 = await batchScreen(preFiltered);

  // 5. Filter candidates
  const candidates = filterStage1Candidates(stage1);
  log.info(`${candidates.length} candidates for Stage 2`);

  if (candidates.length === 0) {
    const cost = getApiCostEstimate();
    state.totalApiCost += cost;
    state.dailyApiCost += cost;
    log.info(`No candidates. API cost: $${cost.toFixed(4)}`);
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    savePaperState(state);
    return;
  }

  // 6. Stage 2: All 3 models analyze in parallel
  log.info(`Stage 2: ${ESTIMATION.ensembleModels.length} models analyzing ${candidates.length} candidates in parallel...`);
  const signals = await analyzeMarkets(candidates, marketMap);

  const estimationCost = getApiCostEstimate();
  const researchCost = getResearchCostEstimate();
  const cycleCost = estimationCost + researchCost;
  state.totalApiCost += cycleCost;
  state.dailyApiCost += cycleCost;
  log.info(`Cycle API cost: $${cycleCost.toFixed(4)}`);

  if (signals.length === 0) {
    log.info("No signals passed thresholds");
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    savePaperState(state);
    return;
  }

  // 7. Group signals by model, size each model's positions against its own bankroll
  const signalsByModel = new Map<string, typeof signals>();
  for (const sig of signals) {
    const model = sig.model || "unknown";
    if (!signalsByModel.has(model)) signalsByModel.set(model, []);
    signalsByModel.get(model)!.push(sig);
  }

  let totalNewTrades = 0;

  for (const [model, modelSignals] of signalsByModel) {
    const modelBankroll = state.modelBankrolls?.[model] ?? TRADING.initialBankroll;

    // Get this model's open (unresolved) trades for position counting
    const modelOpenTrades = state.trades.filter(
      (t) => t.model === model && !t.resolved
    );
    const fakeOpenPositions = modelOpenTrades.map((t) => ({
      marketId: t.marketId,
      question: t.question,
      conditionId: t.conditionId,
      tokenId: "",
      side: t.side as "YES" | "NO",
      entryPrice: t.entryPrice,
      shares: t.hypotheticalShares,
      costBasis: t.hypotheticalSize,
      timestamp: t.timestamp,
      orderId: t.id,
    }));

    const sized = sizePositions(modelSignals, modelBankroll, fakeOpenPositions);

    for (const pos of sized) {
      const { signal, positionSize, kellyFraction } = pos;

      // Skip if this model already has a trade on this market
      const existing = state.trades.find(
        (t) => t.marketId === signal.market.id && t.model === model && !t.resolved
      );
      if (existing) {
        log.debug(`[${shortName(model)}] Already has trade on "${signal.market.question}", skipping`);
        continue;
      }

      const trade: PaperTrade = {
        id: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        cycleNumber: state.cycleCount + 1,
        marketId: signal.market.id,
        conditionId: signal.market.conditionId,
        question: signal.market.question,
        slug: signal.market.slug,
        endDate: signal.market.endDate,
        marketPriceYes: parseFloat(signal.market.outcomePrices[0]),
        marketPriceNo: parseFloat(signal.market.outcomePrices[1]),
        liquidity: parseFloat(signal.market.liquidity),
        side: signal.side,
        fairYes: signal.fairYes,
        confidence: signal.confidence,
        edge: signal.edge,
        reasoning: signal.reasoning,
        hypotheticalSize: positionSize,
        hypotheticalShares: positionSize / signal.marketPrice,
        entryPrice: signal.marketPrice,
        resolved: false,
        resolution: null,
        resolvedAt: null,
        pnl: null,
        priceHistory: [{ timestamp: Date.now(), priceYes: parseFloat(signal.market.outcomePrices[0]) }],
        model,
      };

      state.trades.push(trade);
      if (state.modelBankrolls) {
        state.modelBankrolls[model] -= positionSize;
      }
      state.simulatedBankroll -= positionSize;
      totalNewTrades++;

      log.info(
        `[${shortName(model)}] Paper trade: ${trade.side} $${positionSize.toFixed(2)} on "${trade.question}" @ ${trade.entryPrice.toFixed(3)} (${(signal.edge * 100).toFixed(1)}% edge)`
      );
    }
  }

  // 9. Persist
  state.cycleCount++;
  state.lastCycleAt = Date.now();
  savePaperState(state);

  // 10. Summary
  const resolved = state.trades.filter((t) => t.resolved);
  const pending = state.trades.filter((t) => !t.resolved);
  const totalPnl = resolved.reduce((s, t) => s + (t.pnl ?? 0), 0);

  log.info("── Cycle Summary ──");
  log.info(`New trades this cycle: ${totalNewTrades}`);
  log.info(`Total trades: ${state.trades.length} (${resolved.length} resolved, ${pending.length} pending)`);

  // Per-model summary
  if (state.modelBankrolls) {
    log.info("── Model Bankrolls ──");
    for (const model of [...ESTIMATION.ensembleModels, "ensemble"]) {
      const bankroll = state.modelBankrolls[model] ?? 0;
      const modelTrades = state.trades.filter((t) => t.model === model);
      const modelResolved = modelTrades.filter((t) => t.resolved);
      const modelPnl = modelResolved.reduce((s, t) => s + (t.pnl ?? 0), 0);
      log.info(
        `  ${shortName(model).padEnd(10)} | $${bankroll.toFixed(2).padStart(8)} | ${modelTrades.length} trades (${modelResolved.length} resolved) | P&L: $${modelPnl >= 0 ? "+" : ""}${modelPnl.toFixed(2)}`
      );
    }
  }

  if (resolved.length > 0) {
    log.info(`Total P&L: $${totalPnl.toFixed(2)}`);
  }
  log.info(`API cost (today): $${state.dailyApiCost.toFixed(4)} / $${TRADING.dailyApiCap}`);
}

export async function runPaperTrader(): Promise<void> {
  log.info("╔═══════════════════════════════════════════════════╗");
  log.info("║     POLYMARKET MODEL HORSE RACE v4.0             ║");
  log.info("║     3 free models + ensemble consensus           ║");
  log.info("╚═══════════════════════════════════════════════════╝");
  log.info(`Models: ${ESTIMATION.ensembleModels.map(shortName).join(", ")}`);
  log.info(`Bankroll per model: $${TRADING.initialBankroll}`);
  log.info(`Cycle interval: ${TRADING.cycleIntervalMs / 60000} minutes`);

  const state = loadPaperState();

  await runPaperCycle(state);

  const resolved = state.trades.filter((t) => t.resolved);
  if (resolved.length > 0) {
    generateReport(state);
  }

  setInterval(async () => {
    try {
      const state = loadPaperState();
      await runPaperCycle(state);

      const resolved = state.trades.filter((t) => t.resolved);
      if (resolved.length > 0) {
        generateReport(state);
      }
    } catch (err) {
      log.error("Paper cycle failed", err);
    }
  }, TRADING.cycleIntervalMs);
}
