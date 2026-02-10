import { TRADING, ESTIMATION } from "./config";
import { GammaMarket, Stage1Estimate, Stage2Estimate, Signal } from "./types";
import { deepAnalyze } from "./estimator";
import { createLogger } from "./logger";

const log = createLogger("analyzer");

export function filterStage1Candidates(
  estimates: Stage1Estimate[]
): Stage1Estimate[] {
  return estimates
    .filter((e) => e.potentialEdge >= ESTIMATION.stage1PotentialEdge)
    .sort((a, b) => b.potentialEdge - a.potentialEdge)
    .slice(0, ESTIMATION.maxStage2Candidates);
}

export async function analyzeMarkets(
  candidates: Stage1Estimate[],
  marketMap: Map<string, GammaMarket>
): Promise<Signal[]> {
  const signals: Signal[] = [];

  for (const candidate of candidates) {
    const market = marketMap.get(candidate.marketId);
    if (!market) continue;

    const estimate = await deepAnalyze(market, candidate.currentYes);
    if (!estimate) continue;

    const signal = evaluateSignal(market, estimate);
    if (signal) {
      signals.push(signal);
      log.info(`Signal found: ${signal.side} on "${market.question}"`, {
        edge: (signal.edge * 100).toFixed(1) + "%",
        confidence: (estimate.confidence * 100).toFixed(0) + "%",
        fair: estimate.fairYes.toFixed(2),
        market: signal.marketPrice.toFixed(2),
      });
    }
  }

  // Sort by edge * confidence (expected value of the edge)
  return signals.sort(
    (a, b) =>
      Math.abs(b.edge) * b.confidence - Math.abs(a.edge) * a.confidence
  );
}

function evaluateSignal(
  market: GammaMarket,
  estimate: Stage2Estimate
): Signal | null {
  const currentYes = parseFloat(market.outcomePrices[0]);
  const currentNo = parseFloat(market.outcomePrices[1]);

  const yesEdge = estimate.fairYes - currentYes; // positive = YES underpriced
  const noEdge = (1 - estimate.fairYes) - currentNo; // positive = NO underpriced

  // Pick the side with more edge
  let side: "YES" | "NO";
  let edge: number;
  let marketPrice: number;
  let tokenId: string;

  if (yesEdge > noEdge) {
    side = "YES";
    edge = yesEdge;
    marketPrice = currentYes;
    tokenId = market.clobTokenIds[0];
  } else {
    side = "NO";
    edge = noEdge;
    marketPrice = currentNo;
    tokenId = market.clobTokenIds[1];
  }

  // Must meet minimum thresholds
  if (edge < TRADING.edgeThreshold) return null;
  if (estimate.confidence < ESTIMATION.stage2MinConfidence) return null;

  // Don't buy at extreme prices (too expensive or too cheap = illiquid)
  if (marketPrice < 0.05 || marketPrice > 0.95) return null;

  return {
    market,
    fairYes: estimate.fairYes,
    confidence: estimate.confidence,
    reasoning: estimate.reasoning,
    edge,
    side,
    marketPrice,
    tokenId,
  };
}
