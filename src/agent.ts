import { TRADING, DRY_RUN } from "./config";
import { GammaMarket } from "./types";
import { getUsdcBalance } from "./wallet";
import { scanMarkets } from "./scanner";
import { batchScreen, getApiCostEstimate, resetSessionCosts } from "./estimator";
import { filterStage1Candidates, analyzeMarkets } from "./analyzer";
import { sizePositions } from "./sizer";
import { executeTrades } from "./executor";
import {
  loadState,
  saveState,
  isAlive,
  canAffordApiCost,
  recordApiCost,
  recordTrade,
  printSummary,
} from "./tracker";
import { createLogger } from "./logger";

const log = createLogger("agent");

async function runCycle(): Promise<void> {
  const state = loadState();

  log.info(`═══ STARTING CYCLE #${state.cycleCount + 1} ═══`);
  if (DRY_RUN) log.info("*** DRY RUN MODE — no real trades ***");

  // 1. Survival check
  if (!isAlive(state)) {
    log.error("Agent is dead. Exiting.");
    process.exit(1);
  }

  // 2. Update balance
  try {
    state.currentBalance = await getUsdcBalance();
    log.info(`USDC balance: $${state.currentBalance.toFixed(2)}`);
  } catch (err) {
    log.error("Failed to fetch balance, using cached", err);
  }

  // Re-check survival with updated balance
  if (!isAlive(state)) {
    log.error("Agent is dead after balance update. Exiting.");
    process.exit(1);
  }

  // 3. Check API budget
  if (!canAffordApiCost(state)) {
    log.warn("Daily API budget exceeded, entering observation mode");
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    printSummary(state);
    saveState(state);
    return;
  }

  // Reset per-cycle cost tracking
  resetSessionCosts();

  // 4. Scan markets
  log.info("Scanning markets...");
  const markets = await scanMarkets();
  if (markets.length === 0) {
    log.warn("No markets found, skipping cycle");
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    saveState(state);
    return;
  }

  // Build lookup map
  const marketMap = new Map<string, GammaMarket>();
  for (const m of markets) {
    marketMap.set(m.id, m);
  }

  // 5. Stage 1: Batch screen
  log.info(`Stage 1: Screening ${markets.length} markets...`);
  const stage1Results = await batchScreen(markets);
  log.info(`Stage 1 complete: ${stage1Results.length} estimates`);

  // 6. Filter candidates for Stage 2
  const candidates = filterStage1Candidates(stage1Results);
  log.info(`${candidates.length} candidates passed Stage 1 filter (>=${(TRADING.edgeThreshold * 100 * 0.75).toFixed(0)}% potential edge)`);

  if (candidates.length === 0) {
    log.info("No candidates — market is fairly priced");
    recordApiCost(state, getApiCostEstimate());
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    printSummary(state);
    saveState(state);
    return;
  }

  // 7. Stage 2: Deep analysis
  log.info(`Stage 2: Deep analysis of ${candidates.length} candidates...`);
  const signals = await analyzeMarkets(candidates, marketMap);
  log.info(`${signals.length} actionable signals found`);

  // Track API costs
  const cycleCost = getApiCostEstimate();
  recordApiCost(state, cycleCost);
  log.info(`Cycle API cost: $${cycleCost.toFixed(4)}`);

  if (signals.length === 0) {
    log.info("No signals passed Stage 2 thresholds");
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    printSummary(state);
    saveState(state);
    return;
  }

  // 8. Size positions
  const sized = sizePositions(signals, state.currentBalance, state.openPositions);
  if (sized.length === 0) {
    log.info("No positions sized (balance too low or positions full)");
    state.cycleCount++;
    state.lastCycleAt = Date.now();
    printSummary(state);
    saveState(state);
    return;
  }

  // 9. Execute trades
  log.info(`Executing ${sized.length} trades...`);
  const results = await executeTrades(sized);

  for (const result of results) {
    recordTrade(state, result);
  }

  const successful = results.filter((r) => r.success).length;
  log.info(`Execution complete: ${successful}/${results.length} orders filled`);

  // 10. Persist state
  state.cycleCount++;
  state.lastCycleAt = Date.now();
  printSummary(state);
  saveState(state);
}

async function main(): Promise<void> {
  log.info("╔════════════════════════════════════╗");
  log.info("║  POLYMARKET AUTONOMOUS AGENT v1.0  ║");
  log.info("╚════════════════════════════════════╝");
  log.info(`Starting bankroll: $${TRADING.initialBankroll}`);
  log.info(`Cycle interval: ${TRADING.cycleIntervalMs / 60000} minutes`);
  log.info(`Dry run: ${DRY_RUN}`);

  // Run first cycle immediately
  await runCycle();

  // Then loop
  setInterval(async () => {
    try {
      await runCycle();
    } catch (err) {
      log.error("Cycle failed with unhandled error", err);
    }
  }, TRADING.cycleIntervalMs);
}

main().catch((err) => {
  log.error("Fatal error", err);
  process.exit(1);
});
