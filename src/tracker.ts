import fs from "fs";
import { STATE_FILE, STATE_DIR, TRADING } from "./config";
import { AgentState, OpenPosition, ClosedPosition, TradeResult } from "./types";
import { createLogger } from "./logger";

const log = createLogger("tracker");

const DEFAULT_STATE: AgentState = {
  startedAt: Date.now(),
  lastCycleAt: 0,
  cycleCount: 0,
  initialBankroll: TRADING.initialBankroll,
  currentBalance: 0,
  openPositions: [],
  closedPositions: [],
  totalPnl: 0,
  totalApiCost: 0,
  dailyApiCost: 0,
  dailyApiCostResetAt: getNextMidnight(),
  alive: true,
};

function getNextMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function loadState(): AgentState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      log.info("Loaded state from disk", {
        cycle: data.cycleCount,
        balance: data.currentBalance,
        openPositions: data.openPositions?.length || 0,
      });
      return data as AgentState;
    }
  } catch (err) {
    log.error("Failed to load state, using defaults", err);
  }
  return { ...DEFAULT_STATE };
}

export function saveState(state: AgentState): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log.debug("State saved to disk");
}

export function isAlive(state: AgentState): boolean {
  const effectiveBalance =
    state.currentBalance +
    state.openPositions.reduce((sum, p) => sum + p.costBasis, 0);

  if (effectiveBalance <= 0) {
    log.error("AGENT DEAD — effective balance is $0");
    state.alive = false;
    saveState(state);
    return false;
  }
  return true;
}

export function canAffordApiCost(state: AgentState): boolean {
  // Reset daily counter if past midnight
  if (Date.now() > state.dailyApiCostResetAt) {
    state.dailyApiCost = 0;
    state.dailyApiCostResetAt = getNextMidnight();
  }

  return state.dailyApiCost < TRADING.dailyApiCap;
}

export function recordApiCost(state: AgentState, cost: number): void {
  state.totalApiCost += cost;
  state.dailyApiCost += cost;
}

export function recordTrade(state: AgentState, result: TradeResult): void {
  if (!result.success) return;

  const position: OpenPosition = {
    marketId: result.signal.market.id,
    question: result.signal.market.question,
    conditionId: result.signal.market.conditionId,
    tokenId: result.signal.tokenId,
    side: result.side,
    entryPrice: result.price,
    shares: result.size / result.price,
    costBasis: result.size,
    timestamp: result.timestamp,
    orderId: result.orderId || "unknown",
  };

  state.openPositions.push(position);
  log.info(`Position opened: ${position.side} ${position.shares.toFixed(2)} shares @ ${position.entryPrice.toFixed(3)}`, {
    market: position.question,
    cost: `$${position.costBasis.toFixed(2)}`,
  });
}

export function closePosition(
  state: AgentState,
  marketId: string,
  exitPrice: number
): void {
  const idx = state.openPositions.findIndex((p) => p.marketId === marketId);
  if (idx === -1) return;

  const open = state.openPositions[idx];
  const proceeds = open.shares * exitPrice;
  const pnl = proceeds - open.costBasis;

  const closed: ClosedPosition = {
    marketId: open.marketId,
    question: open.question,
    side: open.side,
    entryPrice: open.entryPrice,
    exitPrice,
    shares: open.shares,
    costBasis: open.costBasis,
    proceeds,
    pnl,
    resolvedAt: Date.now(),
  };

  state.closedPositions.push(closed);
  state.openPositions.splice(idx, 1);
  state.totalPnl += pnl;

  const emoji = pnl >= 0 ? "WIN" : "LOSS";
  log.info(
    `Position closed [${emoji}]: ${closed.side} "${closed.question}" P&L: $${pnl.toFixed(2)}`,
    {
      entry: closed.entryPrice.toFixed(3),
      exit: exitPrice.toFixed(3),
      proceeds: `$${proceeds.toFixed(2)}`,
    }
  );
}

export function printSummary(state: AgentState): void {
  const exposedCapital = state.openPositions.reduce(
    (sum, p) => sum + p.costBasis,
    0
  );
  const effectiveBalance = state.currentBalance + exposedCapital;

  log.info("═══ CYCLE SUMMARY ═══");
  log.info(`Cycle #${state.cycleCount}`);
  log.info(`USDC Balance: $${state.currentBalance.toFixed(2)}`);
  log.info(`Open Positions: ${state.openPositions.length} ($${exposedCapital.toFixed(2)} exposed)`);
  log.info(`Effective Balance: $${effectiveBalance.toFixed(2)}`);
  log.info(`Total P&L: $${state.totalPnl.toFixed(2)}`);
  log.info(`API Costs: $${state.totalApiCost.toFixed(4)} (today: $${state.dailyApiCost.toFixed(4)})`);
  log.info(`Closed Trades: ${state.closedPositions.length}`);

  if (state.closedPositions.length > 0) {
    const wins = state.closedPositions.filter((p) => p.pnl > 0).length;
    log.info(`Win Rate: ${((wins / state.closedPositions.length) * 100).toFixed(0)}%`);
  }

  log.info("═══════════════════════");
}
