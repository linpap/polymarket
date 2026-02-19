import fs from "fs";
import { createLogger } from "../logger";
import { KALSHI_TRADING, STATE_DIR, KALSHI_STATE_FILE } from "./config";
import { KalshiSignal, KalshiTrade, KalshiState, KalshiStats, KalshiStrategy, KalshiCategory } from "./types";
import { fetchMarket } from "./api";
import { detectCategory } from "./scanner";

const log = createLogger("kalshi-paper");

let state: KalshiState;

function defaultStats(): KalshiStats {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalPnl: 0,
    byStrategy: {
      "crypto-price": { trades: 0, wins: 0, pnl: 0 },
      "cross-arb": { trades: 0, wins: 0, pnl: 0 },
      "llm-fair": { trades: 0, wins: 0, pnl: 0 },
    },
    byCategory: {},
    marketsScanned: 0,
    signalsGenerated: 0,
  };
}

function defaultState(): KalshiState {
  return {
    startedAt: Date.now(),
    bankroll: KALSHI_TRADING.initialBankroll,
    initialBankroll: KALSHI_TRADING.initialBankroll,
    trades: [],
    openPositions: [],
    stats: defaultStats(),
    lastScanTime: 0,
  };
}

// ─── State persistence ───

export function loadState(): KalshiState {
  try {
    if (fs.existsSync(KALSHI_STATE_FILE)) {
      const raw = fs.readFileSync(KALSHI_STATE_FILE, "utf-8");
      state = JSON.parse(raw);
      log.info("Loaded state", {
        bankroll: state.bankroll.toFixed(2),
        trades: state.trades.length,
        open: state.openPositions.length,
      });
      return state;
    }
  } catch (e) {
    log.warn("Failed to load state, starting fresh", (e as Error).message);
  }
  state = defaultState();
  return state;
}

export function saveState(): void {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(KALSHI_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log.error("Failed to save state", (e as Error).message);
  }
}

// ─── Position sizing (Kelly criterion) ───

function calculateSize(signal: KalshiSignal): number {
  // Kelly formula: f* = (bp - q) / b
  // where b = odds (net payout per $1 bet), p = prob of win, q = 1-p
  const p = signal.fairValue;
  const b = (1 / signal.marketPrice) - 1; // net odds
  const q = 1 - p;
  const kelly = Math.max(0, (b * p - q) / b);

  // Apply Kelly fraction (conservative)
  const fraction = kelly * KALSHI_TRADING.kellyFraction;

  // Cap at max position
  const size = Math.min(
    state.bankroll * fraction,
    state.bankroll * KALSHI_TRADING.maxPositionPct,
    KALSHI_TRADING.maxPositionUsd,
    state.bankroll,
  );

  return size;
}

// ─── Paper trade execution ───

export function executePaperTrade(signal: KalshiSignal): KalshiTrade | null {
  // Only one position per ticker — skip if already holding
  const alreadyHolding = state.openPositions.some(
    (p) => p.market.ticker === signal.market.ticker
  );
  if (alreadyHolding) {
    log.debug("Already holding position", { ticker: signal.market.ticker });
    return null;
  }

  const size = calculateSize(signal);

  if (size < 1) {
    log.debug("Trade size too small", { size: size.toFixed(2), bankroll: state.bankroll.toFixed(2) });
    return null;
  }

  const contracts = size / signal.marketPrice;
  const category = detectCategory(signal.market);

  const trade: KalshiTrade = {
    id: `kalshi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    market: {
      ticker: signal.market.ticker,
      title: signal.market.title,
      category,
      close_time: signal.market.close_time,
    },
    strategy: signal.strategy,
    side: signal.side,
    entryPrice: signal.marketPrice,
    size,
    contracts,
    fairValue: signal.fairValue,
    edge: signal.edge,
    confidence: signal.confidence,
    reasoning: signal.reasoning,
    resolved: false,
    result: null,
    pnl: null,
  };

  // Debit bankroll
  state.bankroll -= size;
  state.openPositions.push(trade);
  state.trades.push(trade);

  // Update stats
  state.stats.totalTrades++;
  state.stats.signalsGenerated++;
  state.stats.byStrategy[signal.strategy].trades++;

  if (!state.stats.byCategory[category]) {
    state.stats.byCategory[category] = { trades: 0, wins: 0, pnl: 0 };
  }
  state.stats.byCategory[category].trades++;

  log.info("PAPER TRADE EXECUTED", {
    id: trade.id,
    ticker: trade.market.ticker,
    strategy: trade.strategy,
    side: trade.side,
    size: size.toFixed(2),
    contracts: contracts.toFixed(2),
    entryPrice: (signal.marketPrice * 100).toFixed(1) + "c",
    edge: (signal.edge * 100).toFixed(1) + "%",
    bankroll: state.bankroll.toFixed(2),
  });

  saveState();
  return trade;
}

// ─── Resolution ───

export async function resolveExpired(): Promise<KalshiTrade[]> {
  const now = Date.now();
  const graceMs = KALSHI_TRADING.resolutionGraceMinutes * 60 * 1000;
  const resolved: KalshiTrade[] = [];

  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const trade = state.openPositions[i];
    const closeTime = new Date(trade.market.close_time).getTime();

    // Wait for close + grace period
    if (closeTime + graceMs > now) continue;

    // Check Kalshi API for result
    const fresh = await fetchMarket(trade.market.ticker);
    if (!fresh) {
      log.debug("Could not fetch market for resolution", { ticker: trade.market.ticker });
      continue;
    }

    // Check if settled
    if (!fresh.result || (fresh.result !== "yes" && fresh.result !== "no")) {
      log.debug("Market not yet settled", { ticker: trade.market.ticker, result: fresh.result });
      continue;
    }

    const result = fresh.result as "yes" | "no";
    trade.result = result;
    trade.resolved = true;

    // P&L: binary payout — $1/contract if correct, $0 if wrong
    if (trade.side === result) {
      // Won: receive $1/contract, paid entryPrice/contract
      trade.pnl = trade.contracts * (1.0 - trade.entryPrice);
    } else {
      // Lost: receive $0, paid entryPrice/contract
      trade.pnl = -trade.size;
    }

    // Credit bankroll
    state.bankroll += trade.size + trade.pnl;

    // Update stats
    state.stats.totalPnl += trade.pnl;
    state.stats.byStrategy[trade.strategy].pnl += trade.pnl;

    const category = trade.market.category;
    if (!state.stats.byCategory[category]) {
      state.stats.byCategory[category] = { trades: 0, wins: 0, pnl: 0 };
    }
    state.stats.byCategory[category].pnl += trade.pnl;

    if (trade.pnl > 0) {
      state.stats.wins++;
      state.stats.byStrategy[trade.strategy].wins++;
      state.stats.byCategory[category].wins++;
    } else {
      state.stats.losses++;
    }

    // Win rate
    const totalResolved = state.stats.wins + state.stats.losses;
    state.stats.winRate = totalResolved > 0 ? state.stats.wins / totalResolved : 0;

    // Update in full trades array
    const fullIdx = state.trades.findIndex((t) => t.id === trade.id);
    if (fullIdx !== -1) state.trades[fullIdx] = trade;

    // Remove from open
    state.openPositions.splice(i, 1);
    resolved.push(trade);

    log.info("TRADE RESOLVED", {
      id: trade.id,
      ticker: trade.market.ticker,
      side: trade.side,
      result,
      pnl: trade.pnl.toFixed(2),
      bankroll: state.bankroll.toFixed(2),
    });
  }

  if (resolved.length > 0) saveState();
  return resolved;
}

// ─── Stats tracking ───

export function recordScan(marketsFound: number): void {
  state.stats.marketsScanned += marketsFound;
}

// ─── Getters ───

export function getStats(): KalshiStats { return state.stats; }
export function getBankroll(): number { return state.bankroll; }
export function getOpenPositions(): KalshiTrade[] { return state.openPositions; }
export function getState(): KalshiState { return state; }
