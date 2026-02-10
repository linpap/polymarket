import "dotenv/config";
import { runPaperTrader } from "../src/paper-trader";
import { createLogger } from "../src/logger";

const log = createLogger("main");

runPaperTrader().catch((err) => {
  log.error("Fatal error in paper trader", err);
  process.exit(1);
});
