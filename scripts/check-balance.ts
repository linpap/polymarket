import "dotenv/config";
import { getWallet, getUsdcBalance, getPolBalance } from "../src/wallet";
import { loadState } from "../src/tracker";
import { createLogger } from "../src/logger";

const log = createLogger("balance");

async function main() {
  const wallet = getWallet();
  log.info(`Wallet: ${wallet.address}`);

  const [usdc, pol] = await Promise.all([getUsdcBalance(), getPolBalance()]);
  log.info(`USDC.e: $${usdc.toFixed(2)}`);
  log.info(`POL: ${pol.toFixed(4)}`);

  const state = loadState();
  if (state.cycleCount > 0) {
    log.info(`\nAgent Status:`);
    log.info(`  Alive: ${state.alive}`);
    log.info(`  Cycles: ${state.cycleCount}`);
    log.info(`  Open Positions: ${state.openPositions.length}`);
    log.info(`  Total P&L: $${state.totalPnl.toFixed(2)}`);
    log.info(`  API Costs: $${state.totalApiCost.toFixed(4)}`);

    const exposedCapital = state.openPositions.reduce(
      (sum, p) => sum + p.costBasis,
      0
    );
    log.info(`  Exposed Capital: $${exposedCapital.toFixed(2)}`);
    log.info(`  Effective Balance: $${(usdc + exposedCapital).toFixed(2)}`);

    if (state.openPositions.length > 0) {
      log.info(`\nOpen Positions:`);
      for (const p of state.openPositions) {
        log.info(`  ${p.side} "${p.question}" — ${p.shares.toFixed(2)} shares @ ${p.entryPrice.toFixed(3)} ($${p.costBasis.toFixed(2)})`);
      }
    }
  } else {
    log.info("Agent has not run yet.");
  }
}

main().catch((err) => {
  log.error("Error", err);
  process.exit(1);
});
