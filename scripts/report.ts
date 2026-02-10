import "dotenv/config";
import { loadPaperState } from "../src/paper-trader";
import { checkResolutions, flagExpiredUnresolved } from "../src/resolver";
import { generateReport } from "../src/reporter";
import { savePaperState } from "../src/paper-trader";
import { createLogger } from "../src/logger";

const log = createLogger("report");

async function main() {
  const state = loadPaperState();

  if (state.trades.length === 0) {
    log.info("No paper trades recorded yet. Run the paper trader first:");
    log.info("  npm run paper-trade");
    return;
  }

  // Check for new resolutions before reporting
  log.info("Checking for new resolutions...");
  state.trades = await checkResolutions(state.trades);

  // Update bankroll for newly resolved
  const justResolved = state.trades.filter(
    (t) => t.resolved && t.pnl !== null
  );

  // Recompute bankroll from scratch to avoid drift
  let bankroll = state.initialBankroll;
  for (const t of state.trades) {
    bankroll -= t.hypotheticalSize; // deduct cost basis
    if (t.resolved && t.pnl !== null) {
      bankroll += t.hypotheticalSize + t.pnl; // add back cost + P&L
    }
  }
  state.simulatedBankroll = bankroll;

  savePaperState(state);
  flagExpiredUnresolved(state.trades);

  // Generate full report
  generateReport(state);
}

main().catch((err) => {
  log.error("Report failed", err);
  process.exit(1);
});
