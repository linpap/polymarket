import fs from "fs";
import path from "path";
import { createLogger } from "../logger";
import { UPDOWN_TRADING, STATE_DIR, UPDOWN_STATE_FILE } from "./config";
import { ArbitrageSignal, PaperTrade, UpDownState, UpDownStats, SignalType } from "./types";
import { getPrice } from "./binance-feed";
import { ASSET_TO_SYMBOL } from "./config";

const log = createLogger("paper-engine");

let state: UpDownState;

function defaultStats(): UpDownStats {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalPnl: 0,
    byStrategy: {
      latency: { trades: 0, wins: 0, pnl: 0 },
      "complete-set": { trades: 0, wins: 0, pnl: 0 },
      "cross-platform": { trades: 0, wins: 0, pnl: 0 },
    },
    opportunitiesSeen: 0,
    opportunitiesSkipped: 0,
  };
}

function defaultState(): UpDownState {
  return {
    startedAt: Date.now(),
    bankroll: UPDOWN_TRADING.initialBankroll,
    initialBankroll: UPDOWN_TRADING.initialBankroll,
    trades: [],
    openPositions: [],
    stats: defaultStats(),
    lastStatusLog: 0,
  };
}

// ─── State persistence ───

export function loadState(): UpDownState {
  try {
    if (fs.existsSync(UPDOWN_STATE_FILE)) {
      const raw = fs.readFileSync(UPDOWN_STATE_FILE, "utf-8");
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
    fs.writeFileSync(UPDOWN_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log.error("Failed to save state", (e as Error).message);
  }
}

// ─── Paper trade execution ───

export function executePaperTrade(signal: ArbitrageSignal): PaperTrade | null {
  // Calculate position size
  let size: number;
  if (signal.type === "complete-set") {
    // For complete-set, we can size larger since it's guaranteed profit
    size = Math.min(
      state.bankroll * 0.10, // up to 10%
      UPDOWN_TRADING.maxPositionUsd * 2, // up to $1000
      state.bankroll
    );
  } else {
    // Latency arb: scaled by confidence
    const baseSize = state.bankroll * UPDOWN_TRADING.maxPositionPct;
    size = Math.min(
      baseSize * signal.confidence,
      UPDOWN_TRADING.maxPositionUsd,
      state.bankroll
    );
  }

  if (size < 1) {
    log.warn("Trade size too small, skipping", { size, bankroll: state.bankroll });
    return null;
  }

  // Calculate entry price and shares
  let entryPriceYes: number;
  let entryPriceNo: number;
  let shares: number;

  if (signal.action === "buy-both") {
    entryPriceYes = signal.market.currentYes;
    entryPriceNo = signal.market.currentNo;
    // Buy equal dollar amounts of each
    const costPerSet = entryPriceYes + entryPriceNo;
    shares = size / costPerSet;
  } else if (signal.action === "buy-yes") {
    entryPriceYes = signal.market.currentYes;
    entryPriceNo = signal.market.currentNo;
    shares = size / entryPriceYes;
  } else {
    entryPriceYes = signal.market.currentYes;
    entryPriceNo = signal.market.currentNo;
    shares = size / entryPriceNo;
  }

  const binance = getPrice(ASSET_TO_SYMBOL[signal.market.asset] || "btcusdt");

  const trade: PaperTrade = {
    id: `updown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    market: {
      marketId: signal.market.marketId,
      question: signal.market.question,
      asset: signal.market.asset,
      strikePrice: signal.market.strikePrice,
      windowEnd: signal.market.windowEnd,
    },
    strategy: signal.type,
    side: signal.action === "buy-both" ? "BOTH" : signal.action === "buy-yes" ? "YES" : "NO",
    entryPriceYes,
    entryPriceNo,
    size,
    shares,
    binancePriceAtEntry: binance?.price || 0,
    edge: signal.edge,
    confidence: signal.confidence,
    reasoning: signal.reasoning,
    resolved: false,
    outcome: null,
    binancePriceAtExpiry: null,
    pnl: null,
  };

  // Debit bankroll
  state.bankroll -= size;
  state.openPositions.push(trade);
  state.trades.push(trade);
  state.stats.totalTrades++;
  state.stats.byStrategy[signal.type].trades++;

  log.info("PAPER TRADE EXECUTED", {
    id: trade.id,
    strategy: trade.strategy,
    side: trade.side,
    asset: trade.market.asset,
    size: size.toFixed(2),
    shares: shares.toFixed(2),
    edge: (signal.edge * 100).toFixed(1) + "%",
    bankroll: state.bankroll.toFixed(2),
  });

  saveState();
  return trade;
}

// ─── Resolution ───

export function resolveExpired(): PaperTrade[] {
  const now = Date.now();
  const resolved: PaperTrade[] = [];

  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const trade = state.openPositions[i];
    if (trade.market.windowEnd > now) continue; // not expired yet

    // Get Binance price at expiry (or current if recently expired)
    const symbol = ASSET_TO_SYMBOL[trade.market.asset] || "btcusdt";
    const binance = getPrice(symbol);
    const expiryPrice = binance?.price || 0;

    trade.binancePriceAtExpiry = expiryPrice;

    // Determine outcome
    // If strikePrice is set, compare against it
    // Otherwise, compare against entry price (did it go up or down?)
    let outcome: "YES" | "NO";
    if (trade.market.strikePrice > 0) {
      outcome = expiryPrice >= trade.market.strikePrice ? "YES" : "NO";
    } else {
      // No strike price means the market is about whether price went up/down
      // from some reference. Use the entry Binance price as reference
      outcome = expiryPrice >= trade.binancePriceAtEntry ? "YES" : "NO";
    }

    trade.outcome = outcome;
    trade.resolved = true;

    // Calculate P&L
    if (trade.side === "BOTH") {
      // Complete-set: always wins $1 per share, cost was YES + NO per share
      const costPerShare = trade.entryPriceYes + trade.entryPriceNo;
      trade.pnl = trade.shares * (1.0 - costPerShare);
    } else if (trade.side === outcome) {
      // We bought the winning side: get $1/share
      const entryPrice = trade.side === "YES" ? trade.entryPriceYes : trade.entryPriceNo;
      trade.pnl = trade.shares * (1.0 - entryPrice);
    } else {
      // We bought the losing side: get $0/share
      trade.pnl = -trade.size;
    }

    // Credit bankroll
    if (trade.pnl !== null) {
      state.bankroll += trade.size + trade.pnl;

      // Update stats
      state.stats.totalPnl += trade.pnl;
      state.stats.byStrategy[trade.strategy].pnl += trade.pnl;

      if (trade.pnl > 0) {
        state.stats.wins++;
        state.stats.byStrategy[trade.strategy].wins++;
      } else {
        state.stats.losses++;
      }
    }

    // Update win rate
    const totalResolved = state.stats.wins + state.stats.losses;
    state.stats.winRate = totalResolved > 0 ? state.stats.wins / totalResolved : 0;

    // Also update the trade in the full trades array
    const fullIdx = state.trades.findIndex((t) => t.id === trade.id);
    if (fullIdx !== -1) {
      state.trades[fullIdx] = trade;
    }

    // Remove from open positions
    state.openPositions.splice(i, 1);
    resolved.push(trade);

    log.info("TRADE RESOLVED", {
      id: trade.id,
      asset: trade.market.asset,
      side: trade.side,
      outcome,
      pnl: trade.pnl?.toFixed(2),
      binanceEntry: trade.binancePriceAtEntry.toFixed(2),
      binanceExpiry: expiryPrice.toFixed(2),
      bankroll: state.bankroll.toFixed(2),
    });
  }

  if (resolved.length > 0) {
    saveState();
  }

  return resolved;
}

// ─── Opportunity tracking ───

export function recordOpportunity(traded: boolean): void {
  state.stats.opportunitiesSeen++;
  if (!traded) state.stats.opportunitiesSkipped++;
}

// ─── Getters ───

export function getStats(): UpDownStats {
  return state.stats;
}

export function getBankroll(): number {
  return state.bankroll;
}

export function getOpenPositions(): PaperTrade[] {
  return state.openPositions;
}

export function getState(): UpDownState {
  return state;
}
