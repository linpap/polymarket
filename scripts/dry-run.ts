import "dotenv/config";

// Force dry run mode
process.env.DRY_RUN = "true";

import { TRADING } from "../src/config";
import { GammaMarket } from "../src/types";
import { getUsdcBalance } from "../src/wallet";
import { scanMarkets } from "../src/scanner";
import { batchScreen, getApiCostEstimate, resetSessionCosts } from "../src/estimator";
import { filterStage1Candidates, analyzeMarkets } from "../src/analyzer";
import { sizePositions } from "../src/sizer";
import { executeTrades } from "../src/executor";
import { createLogger } from "../src/logger";

const log = createLogger("dry-run");

async function main() {
  log.info("╔════════════════════════════════════╗");
  log.info("║     DRY RUN — NO REAL TRADES       ║");
  log.info("╚════════════════════════════════════╝");

  // 1. Check balance
  let balance: number;
  try {
    balance = await getUsdcBalance();
    log.info(`Live USDC balance: $${balance.toFixed(2)}`);
  } catch {
    balance = TRADING.initialBankroll;
    log.info(`Using default bankroll: $${balance.toFixed(2)}`);
  }

  // 2. Scan markets
  log.info("\n═══ SCANNING MARKETS ═══");
  const markets = await scanMarkets();

  const marketMap = new Map<string, GammaMarket>();
  for (const m of markets) marketMap.set(m.id, m);

  // 3. Stage 1
  log.info("\n═══ STAGE 1: BATCH SCREENING ═══");
  resetSessionCosts();
  const stage1 = await batchScreen(markets);
  log.info(`Stage 1 estimates: ${stage1.length}`);

  // Show top 10 by edge
  const topEdges = [...stage1].sort((a, b) => b.potentialEdge - a.potentialEdge).slice(0, 10);
  for (const e of topEdges) {
    log.info(`  ${(e.potentialEdge * 100).toFixed(1)}% edge — "${e.question}" (fair: ${e.fairYes.toFixed(2)}, mkt: ${e.currentYes.toFixed(2)})`);
  }

  // 4. Filter candidates
  const candidates = filterStage1Candidates(stage1);
  log.info(`\n${candidates.length} candidates for Stage 2`);

  if (candidates.length === 0) {
    log.info("No candidates — markets appear fairly priced");
    log.info(`API cost: $${getApiCostEstimate().toFixed(4)}`);
    return;
  }

  // 5. Stage 2
  log.info("\n═══ STAGE 2: DEEP ANALYSIS ═══");
  const signals = await analyzeMarkets(candidates, marketMap);
  log.info(`${signals.length} actionable signals`);

  for (const sig of signals) {
    log.info(`\n  Signal: ${sig.side} "${sig.market.question}"`);
    log.info(`    Edge: ${(sig.edge * 100).toFixed(1)}%`);
    log.info(`    Fair: ${sig.fairYes.toFixed(2)} | Market: ${sig.marketPrice.toFixed(2)}`);
    log.info(`    Confidence: ${(sig.confidence * 100).toFixed(0)}%`);
    log.info(`    Reasoning: ${sig.reasoning.substring(0, 200)}...`);
  }

  // 6. Size
  log.info("\n═══ POSITION SIZING ═══");
  const sized = sizePositions(signals, balance, []);
  for (const pos of sized) {
    log.info(`  $${pos.positionSize.toFixed(2)} on ${pos.signal.side} "${pos.signal.market.question}" (Kelly: ${(pos.kellyFraction * 100).toFixed(1)}%)`);
  }

  // 7. Execute (dry run)
  if (sized.length > 0) {
    log.info("\n═══ EXECUTION (DRY RUN) ═══");
    const results = await executeTrades(sized);
    for (const r of results) {
      log.info(`  [${r.success ? "OK" : "FAIL"}] ${r.side} $${r.size.toFixed(2)} @ ${r.price.toFixed(3)}`);
    }
  }

  // Summary
  const apiCost = getApiCostEstimate();
  log.info("\n═══ SUMMARY ═══");
  log.info(`Markets scanned: ${markets.length}`);
  log.info(`Stage 1 candidates: ${candidates.length}`);
  log.info(`Stage 2 signals: ${signals.length}`);
  log.info(`Trades sized: ${sized.length}`);
  log.info(`Estimated API cost: $${apiCost.toFixed(4)}`);
  log.info(`Projected daily cost (144 cycles): $${(apiCost * 144).toFixed(2)}`);
}

main().catch((err) => {
  log.error("Dry run failed", err);
  process.exit(1);
});
