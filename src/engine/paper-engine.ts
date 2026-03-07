import fs from "fs";
import { createLogger } from "../logger";
import { TRADING, STATE_DIR, STATE_FILE, ASSET_TO_SYMBOL } from "../config";
import { Signal, PaperTrade, BotState, BotStats, StrategyType, Market } from "../types";
import { getPrice } from "../feeds/coinbase";
import { getMarketBooks } from "../markets/orderbook";
import { sizePosition } from "./sizer";

const log = createLogger("paper-engine");

const ALL_STRATEGIES: StrategyType[] = ["bayesian-lmsr", "complete-set"];

let state: BotState;

function defaultStats(): BotStats {
  const byStrategy: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const s of ALL_STRATEGIES) {
    byStrategy[s] = { trades: 0, wins: 0, pnl: 0 };
  }
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalPnl: 0,
    byStrategy,
    opportunitiesSeen: 0,
    opportunitiesSkipped: 0,
  };
}

function defaultState(): BotState {
  return {
    startedAt: Date.now(),
    bankroll: TRADING.initialBankroll,
    initialBankroll: TRADING.initialBankroll,
    trades: [],
    openPositions: [],
    stats: defaultStats(),
    lastStatusLog: 0,
  };
}

// ── State persistence ──

export function loadState(): BotState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      state = JSON.parse(raw);
      // Ensure all current strategy keys exist
      for (const s of ALL_STRATEGIES) {
        if (!state.stats.byStrategy[s]) {
          state.stats.byStrategy[s] = { trades: 0, wins: 0, pnl: 0 };
        }
      }
      log.info("Loaded state", {
        bankroll: "$" + state.bankroll.toFixed(2),
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
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log.error("Failed to save state", (e as Error).message);
  }
}

// ── Paper trade execution ──

export async function executePaperTrade(signal: Signal): Promise<PaperTrade | null> {
  // Max 1 open position per specific market question
  const marketPositions = state.openPositions.filter(
    p => p.market.marketId === signal.market.marketId
  );
  if (marketPositions.length >= 1) return null;

  // Max positions per asset (e.g., max 20 BTC positions across different time windows)
  if (signal.market.asset) {
    const assetPositions = state.openPositions.filter(
      p => p.market.asset === signal.market.asset
    );
    if (assetPositions.length >= TRADING.maxPositionsPerAsset) return null;
  }

  // Max total open positions
  if (state.openPositions.length >= TRADING.maxOpenPositions) return null;

  // Get fresh books for sizing (sizer checks slippage on both sides for buy-both)
  const books = await getMarketBooks(signal.market);

  // Size the position (includes slippage gates on correct book(s))
  const sized = sizePosition(signal, state.bankroll, books);
  if (!sized || !sized.size || !sized.shares) return null;

  const coinbase = signal.market.asset
    ? getPrice(ASSET_TO_SYMBOL[signal.market.asset] || "btcusdt")
    : null;

  const trade: PaperTrade = {
    id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    market: {
      marketId: signal.market.marketId,
      question: signal.market.question,
      category: signal.market.category,
      asset: signal.market.asset,
      strikePrice: signal.market.strikePrice,
      windowEnd: signal.market.windowEnd,
    },
    strategy: signal.strategy,
    side: signal.action === "buy-both" ? "BOTH" : signal.action === "buy-yes" ? "YES" : "NO",
    entryPriceYes: books.yes.bestAsk,
    entryPriceNo: books.no.bestAsk,
    vwapEntry: sized.slippage?.vwap || books.yes.bestAsk,
    size: sized.size,
    shares: sized.shares,
    coinbasePriceAtEntry: coinbase?.price || 0,
    edge: signal.edge,
    confidence: signal.confidence,
    reasoning: signal.reasoning,
    resolved: false,
    outcome: null,
    coinbasePriceAtExpiry: null,
    pnl: null,
  };

  // Debit bankroll
  state.bankroll -= trade.size;
  state.openPositions.push(trade);
  state.trades.push(trade);
  state.stats.totalTrades++;
  if (!state.stats.byStrategy[signal.strategy]) {
    state.stats.byStrategy[signal.strategy] = { trades: 0, wins: 0, pnl: 0 };
  }
  state.stats.byStrategy[signal.strategy].trades++;

  log.info("PAPER TRADE EXECUTED", {
    id: trade.id,
    strategy: trade.strategy,
    side: trade.side,
    asset: trade.market.asset || "general",
    size: "$" + trade.size.toFixed(2),
    shares: trade.shares.toFixed(2),
    vwap: trade.vwapEntry.toFixed(4),
    edge: (signal.edge * 100).toFixed(1) + "%",
    bankroll: "$" + state.bankroll.toFixed(2),
  });

  saveState();
  return trade;
}

// ── Resolution ──

export function resolveExpired(): PaperTrade[] {
  const now = Date.now();
  const resolved: PaperTrade[] = [];

  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const trade = state.openPositions[i];
    if (trade.market.windowEnd > now) continue;

    // Resolve based on market type
    if (trade.market.asset) {
      // Crypto: resolve via Coinbase price
      const symbol = ASSET_TO_SYMBOL[trade.market.asset] || "btcusdt";
      const coinbase = getPrice(symbol);
      const expiryPrice = coinbase?.price || 0;
      trade.coinbasePriceAtExpiry = expiryPrice;

      let outcome: "YES" | "NO";
      if (trade.market.strikePrice && trade.market.strikePrice > 0) {
        outcome = expiryPrice >= trade.market.strikePrice ? "YES" : "NO";
      } else {
        outcome = expiryPrice >= trade.coinbasePriceAtEntry ? "YES" : "NO";
      }
      trade.outcome = outcome;
    } else {
      // General market: can't determine yet
      trade.outcome = null;
      continue;
    }

    trade.resolved = true;
    computePnl(trade);

    // Remove from open positions
    state.openPositions.splice(i, 1);
    resolved.push(trade);

    log.info("TRADE RESOLVED", {
      id: trade.id,
      asset: trade.market.asset,
      side: trade.side,
      outcome: trade.outcome,
      pnl: trade.pnl?.toFixed(2),
      bankroll: "$" + state.bankroll.toFixed(2),
    });
  }

  if (resolved.length > 0) saveState();
  return resolved;
}

function computePnl(trade: PaperTrade): void {
  if (!trade.outcome) return;

  if (trade.side === "BOTH") {
    // Complete-set: guaranteed $1/share, cost is VWAP (combined cost per set)
    trade.pnl = trade.shares * (1.0 - trade.vwapEntry);
  } else if (trade.side === trade.outcome) {
    // Won: get $1/share, paid VWAP entry
    trade.pnl = trade.shares * (1.0 - trade.vwapEntry);
  } else {
    // Lost: get $0
    trade.pnl = -trade.size;
  }

  // Credit bankroll
  state.bankroll += trade.size + (trade.pnl || 0);

  // Update stats
  state.stats.totalPnl += trade.pnl || 0;
  if (!state.stats.byStrategy[trade.strategy]) {
    state.stats.byStrategy[trade.strategy] = { trades: 0, wins: 0, pnl: 0 };
  }
  const strat = state.stats.byStrategy[trade.strategy];
  strat.pnl += trade.pnl || 0;

  if (trade.pnl !== null && trade.pnl > 0) {
    state.stats.wins++;
    strat.wins++;
  } else {
    state.stats.losses++;
  }

  const totalResolved = state.stats.wins + state.stats.losses;
  state.stats.winRate = totalResolved > 0 ? state.stats.wins / totalResolved : 0;

  // Update in full trades array
  const idx = state.trades.findIndex(t => t.id === trade.id);
  if (idx !== -1) state.trades[idx] = trade;
}

// ── Opportunity tracking ──

export function recordOpportunity(traded: boolean): void {
  state.stats.opportunitiesSeen++;
  if (!traded) state.stats.opportunitiesSkipped++;
}

// ── Getters ──

export function getStats(): BotStats { return state.stats; }
export function getBankroll(): number { return state.bankroll; }
export function getOpenPositions(): PaperTrade[] { return state.openPositions; }
export function getState(): BotState { return state; }
