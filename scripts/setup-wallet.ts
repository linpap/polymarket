import "dotenv/config";
import { ethers } from "ethers";
import { getWallet, getUsdcBalance, getPolBalance, checkAllowances, approveAll } from "../src/wallet";
import { getClobClient } from "../src/client";
import { createLogger } from "../src/logger";

const log = createLogger("setup");

async function main() {
  log.info("═══ WALLET SETUP ═══");

  const wallet = getWallet();
  log.info(`Wallet address: ${wallet.address}`);

  // Check balances
  const [usdc, pol] = await Promise.all([getUsdcBalance(), getPolBalance()]);
  log.info(`USDC.e balance: $${usdc.toFixed(2)}`);
  log.info(`POL balance: ${pol.toFixed(4)} POL`);

  if (pol < 0.01) {
    log.warn("Low POL balance — you need POL for gas fees. Send ~0.5 POL to your wallet.");
  }

  // Check allowances
  log.info("Checking token allowances...");
  const allowances = await checkAllowances();
  log.info("Allowances:", allowances);

  if (!allowances.usdcToCTF || !allowances.ctfToExchange || !allowances.ctfToNegRisk) {
    log.info("Missing allowances detected. Approving...");
    await approveAll();
    log.info("All allowances approved!");
  } else {
    log.info("All allowances already set.");
  }

  // Derive API key
  log.info("Deriving CLOB API credentials...");
  const client = await getClobClient();
  log.info("CLOB client initialized and credentials cached.");

  log.info("═══ SETUP COMPLETE ═══");
  log.info("You can now run: npm start (or npm run dry-run)");
}

main().catch((err) => {
  log.error("Setup failed", err);
  process.exit(1);
});
