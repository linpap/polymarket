import fs from "fs";
import path from "path";
import { TRADING, STATE_DIR } from "./config";
import { GammaMarket, PaperTrade, PaperTradeState } from "./types";
import { scanMarkets } from "./scanner";
import { batchScreen, getApiCostEstimate, resetSessionCosts } from "./estimator";
import { filterStage1Candidates, analyzeMarkets } from "./analyzer";
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
};

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

    // Update simulated bankroll from newly resolved trades
    const justResolved = state.trades.filter(
      (t) => t.resolved && t.resolvedAt && Date.now() - t.resolvedAt < TRADING.cycleIntervalMs * 2
    );
    for (const t of justResolved) {
      if (t.pnl !== null) {
        state.simulatedBankroll += t.pnl;
        const tag = t.pnl > 0 ? "WIN" : "LOSS";
        log.info(
          `[${tag}] "${t.question}" — ${t.side} resolved ${t.resolution}, P&L: $${t.pnl.toFixed(2)}`
        );
      }
    }

    flagExpiredUnresolved(state.trades);
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

  const marketMap = new Map<string, GammaMarket>();
  for (const m of markets) marketMap.set(m.id, m);

  // 4. Stage 1: Batch screen
  resetSessionCosts();
  log.info(`Stage 1: Screening ${markets.length} markets...`);
  const stage1 = await batchScreen(markets);

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

  // 6. Stage 2: Deep analysis
  log.info(`Stage 2: Analyzing ${candidates.length} candidates...`);
  const signals = await analyzeMarkets(candidates, marketMap);

  // Track API cost
  const cycleCost = getApiCostEstimate();
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

  // 7. Size positions (against simulated bankroll)
  const openUnresolved = state.trades.filter((t) => !t.resolved);
  // Convert to the format sizer expects
  const fakeOpenPositions = openUnresolved.map((t) => ({
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

  const sized = sizePositions(signals, state.simulatedBankroll, fakeOpenPositions);

  // 8. Record paper trades
  for (const pos of sized) {
    const { signal, positionSize, kellyFraction } = pos;

    // Skip if we already have a trade on this market
    const existing = state.trades.find(
      (t) => t.marketId === signal.market.id && !t.resolved
    );
    if (existing) {
      log.debug(`Already have paper trade on "${signal.market.question}", skipping`);
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
    };

    state.trades.push(trade);
    state.simulatedBankroll -= positionSize; // deduct from bankroll

    log.info(
      `Paper trade: ${trade.side} $${positionSize.toFixed(2)} on "${trade.question}" @ ${trade.entryPrice.toFixed(3)} (${(signal.edge * 100).toFixed(1)}% edge, Kelly ${(kellyFraction * 100).toFixed(1)}%)`
    );
  }

  // 9. Persist
  state.cycleCount++;
  state.lastCycleAt = Date.now();
  savePaperState(state);

  // 10. Quick summary
  const resolved = state.trades.filter((t) => t.resolved);
  const pending = state.trades.filter((t) => !t.resolved);
  const totalPnl = resolved.reduce((s, t) => s + (t.pnl ?? 0), 0);

  log.info("── Cycle Summary ──");
  log.info(`Trades this cycle: ${sized.length}`);
  log.info(`Total trades: ${state.trades.length} (${resolved.length} resolved, ${pending.length} pending)`);
  log.info(`Simulated bankroll: $${state.simulatedBankroll.toFixed(2)}`);
  if (resolved.length > 0) {
    log.info(`Total P&L: $${totalPnl.toFixed(2)}`);
  }
  log.info(`API cost (today): $${state.dailyApiCost.toFixed(4)} / $${TRADING.dailyApiCap}`);
}

export async function runPaperTrader(): Promise<void> {
  log.info("╔═══════════════════════════════════════════════════╗");
  log.info("║     POLYMARKET PAPER TRADER v1.0                 ║");
  log.info("║     No real money — tracking hypothetical P&L    ║");
  log.info("╚═══════════════════════════════════════════════════╝");
  log.info(`Simulated bankroll: $${TRADING.initialBankroll}`);
  log.info(`Cycle interval: ${TRADING.cycleIntervalMs / 60000} minutes`);

  const state = loadPaperState();

  // Run first cycle immediately
  await runPaperCycle(state);

  // Generate report after each cycle if we have resolved trades
  const resolved = state.trades.filter((t) => t.resolved);
  if (resolved.length > 0) {
    generateReport(state);
  }

  // Then loop
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
