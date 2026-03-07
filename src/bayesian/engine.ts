/**
 * Bayesian Belief Engine — snapshot mode.
 *
 * Each evaluation cycle:
 *   1. Prior = current market midpoint (latest crowd consensus)
 *   2. Apply signal likelihoods (single Bayesian step)
 *   3. Normalize → posterior
 *   4. Posterior is returned but NOT accumulated
 *
 * This avoids the repeated-evidence accumulation bug: the same
 * orderbook state doesn't get counted as "new evidence" every cycle.
 */

import { MarketBooks, SignalLikelihood } from "../types";

export interface SnapshotResult {
  priorYes: number;
  posteriorYes: number;
  posteriorNo: number;
  signalCount: number;
}

// Track which markets we've seen (for rate-limiting only)
const lastEvalTime: Map<string, number> = new Map();

// ── Log-space utilities ──

function logSumExp(a: number, b: number): number {
  const max = Math.max(a, b);
  if (!isFinite(max)) return -Infinity;
  return max + Math.log(Math.exp(a - max) + Math.exp(b - max));
}

function logNormalize(logYes: number, logNo: number): [number, number] {
  const logZ = logSumExp(logYes, logNo);
  return [logYes - logZ, logNo - logZ];
}

// ── Public API ──

/**
 * Compute posterior from current market state + signals.
 * Stateless per call — no accumulation across cycles.
 *
 * Prior comes from the current orderbook midpoint (crowd consensus).
 * Signals shift the posterior away from consensus when they have info.
 */
export function computePosterior(
  books: MarketBooks,
  signals: SignalLikelihood[],
): SnapshotResult {
  // Prior from current market midpoint
  const priorYes = Math.max(0.01, Math.min(0.99, books.yes.midpoint));
  let logYes = Math.log(priorYes);
  let logNo = Math.log(1 - priorYes);

  // Single Bayesian step: prior × Π likelihoods
  for (const signal of signals) {
    const likYes = Math.max(1e-10, signal.likelihoodYes);
    const likNo = Math.max(1e-10, signal.likelihoodNo);

    logYes += signal.weight * Math.log(likYes);
    logNo += signal.weight * Math.log(likNo);
  }

  // Normalize
  [logYes, logNo] = logNormalize(logYes, logNo);

  return {
    priorYes,
    posteriorYes: Math.exp(logYes),
    posteriorNo: Math.exp(logNo),
    signalCount: signals.length,
  };
}

/**
 * Rate-limit: check if enough time has passed since last eval.
 */
export function canEvaluate(marketId: string, intervalMs: number): boolean {
  const last = lastEvalTime.get(marketId) || 0;
  if (Date.now() - last < intervalMs) return false;
  lastEvalTime.set(marketId, Date.now());
  return true;
}

/**
 * Prune rate-limit entries for expired markets.
 */
export function cleanupBeliefs(activeMarketIds: Set<string>): number {
  let pruned = 0;
  for (const id of lastEvalTime.keys()) {
    if (!activeMarketIds.has(id)) {
      lastEvalTime.delete(id);
      pruned++;
    }
  }
  return pruned;
}
