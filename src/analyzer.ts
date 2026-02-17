import { TRADING, ESTIMATION, CALIBRATION, CATEGORY_MULTIPLIERS, RESEARCH } from "./config";
import { GammaMarket, Stage1Estimate, Stage2Estimate, Signal } from "./types";
import { deepAnalyze } from "./estimator";
import { researchMarket } from "./research";
import { fetchMarketById } from "./scanner";
import { createLogger } from "./logger";

const log = createLogger("analyzer");

// ─── Market categorization ───

export type MarketCategory =
  | "speech"
  | "political"
  | "niche"
  | "financial"
  | "sports"
  | "esports"
  | "crypto"
  | "weather";

export function categorizeMarket(question: string): MarketCategory {
  const q = question.toLowerCase();

  if (/temperature|°[fc]|snowfall|rainfall|weather|inches.*snow|wind speed|highest temp/.test(q))
    return "weather";
  if (/price of (bitcoin|btc|ethereum|eth|xrp|sol|doge|bnb)|above \$[\d,]+.*on (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(q))
    return "crypto";
  if (/\b(lol|dota|csgo|cs2|valorant|overwatch|esports|lfl|lec|lck|lpl|vct)\b/i.test(q))
    return "esports";
  if (/o\/u \d|over.*under|total.*\d.*goals|: o\/u/i.test(q)) return "sports";
  if (/\bvs\.?\b.*\b(fc|united|city|club|redhawks|broncos|celtics|lakers|chiefs|eagles|esports)\b/i.test(q))
    return "sports";
  if (/\b(nba|nfl|mlb|nhl|epl|la liga|serie a|ligue 1|euroleague|lol:|cbb|ncaa)\b/i.test(q))
    return "sports";
  if (/will.*say\b|during.*rally|during.*speech|during.*debate|will.*mention/i.test(q))
    return "speech";
  if (/government|shutdown|tariff|congress|senate|president|election|vote|legislation|bill|executive order|sanctions|impeach|pardon/i.test(q))
    return "political";
  if (/s&p|dow|nasdaq|gold|oil|fed.*rate|interest rate|cpi|inflation|gdp|treasury|yield/i.test(q))
    return "financial";

  return "niche";
}

export function prioritizeMarkets(markets: GammaMarket[]): GammaMarket[] {
  const categorized = markets.map((m) => ({
    market: m,
    category: categorizeMarket(m.question),
    multiplier: CATEGORY_MULTIPLIERS[categorizeMarket(m.question)] ?? 1.0,
  }));

  const counts: Record<string, number> = {};
  for (const c of categorized) {
    counts[c.category] = (counts[c.category] || 0) + 1;
  }
  log.info("Market categories", counts);

  categorized.sort((a, b) => b.multiplier - a.multiplier);
  return categorized.map((c) => c.market);
}

// ─── Stage 1 filtering ───

export function filterStage1Candidates(
  estimates: Stage1Estimate[]
): Stage1Estimate[] {
  return estimates
    .filter((e) => e.potentialEdge >= ESTIMATION.stage1PotentialEdge)
    .sort((a, b) => b.potentialEdge - a.potentialEdge)
    .slice(0, ESTIMATION.maxStage2Candidates);
}

// ─── Helper: short model name for logs ───

function shortName(model: string): string {
  if (model === "ensemble") return "ensemble";
  if (model.includes("deepseek")) return "deepseek";
  if (model.includes("gemma")) return "gemma";
  if (model.includes("hermes")) return "hermes";
  return model.split("/").pop()?.split(":")[0] || model;
}

// ─── Stage 2: Multi-model parallel analysis ───
// Each model independently evaluates each candidate and produces its own signals.
// No agreement required — this is a horse race between models.

export async function analyzeMarkets(
  candidates: Stage1Estimate[],
  marketMap: Map<string, GammaMarket>
): Promise<Signal[]> {
  const signals: Signal[] = [];
  const models = ESTIMATION.ensembleModels;
  let researchCount = 0;

  for (const candidate of candidates) {
    const market = marketMap.get(candidate.marketId);
    if (!market) continue;

    const category = categorizeMarket(market.question);

    // Optional web research (shared across models)
    let context: string | undefined;
    if (RESEARCH.enabled && researchCount < RESEARCH.maxSearchesPerCycle) {
      log.info(`Researching [${category}]: "${market.question.slice(0, 60)}..."`);
      context = await researchMarket(market.question, market.endDate, category);
      researchCount++;
    }

    // Run all models in parallel on this candidate
    const results = await Promise.all(
      models.map(async (model, i) => {
        // Stagger parallel calls by 1s to avoid rate limits
        if (i > 0) await new Promise((r) => setTimeout(r, i * 1000));
        try {
          const estimate = await deepAnalyze(market, candidate.currentYes, context || undefined, model);
          return { model, estimate };
        } catch (err) {
          log.warn(`[${shortName(model)}] Failed on "${market.question.slice(0, 40)}...": ${err}`);
          return { model, estimate: null };
        }
      })
    );

    // Small delay between candidates to respect rate limits
    await new Promise((r) => setTimeout(r, 2000));

    // Each model independently produces a signal
    for (const { model, estimate } of results) {
      if (!estimate) continue;

      const sig = evaluateSignal(market, estimate, category);
      if (sig) {
        sig.model = model;
        signals.push(sig);
        log.info(
          `[${shortName(model)}] ${sig.side} "${market.question.slice(0, 50)}..." — edge ${(Math.abs(sig.edge) * 100).toFixed(1)}%, conf ${(sig.confidence * 100).toFixed(0)}%, basis: ${sig.informationBasis}`
        );
      }
    }
  }

  // ─── Ensemble consensus: virtual signal from majority vote ───
  const ensembleSignals = generateEnsembleSignals(signals, marketMap);
  signals.push(...ensembleSignals);

  // Sort by edge magnitude
  return signals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}

// ─── Ensemble consensus logic ───
// For each market with 2+ model signals, generate a virtual "ensemble" signal
// using majority vote on side, median fairYes, and scaled confidence.

function generateEnsembleSignals(
  signals: Signal[],
  marketMap: Map<string, GammaMarket>
): Signal[] {
  const ensembleSignals: Signal[] = [];

  // Group signals by market ID
  const byMarket = new Map<string, Signal[]>();
  for (const sig of signals) {
    const mid = sig.market.id;
    if (!byMarket.has(mid)) byMarket.set(mid, []);
    byMarket.get(mid)!.push(sig);
  }

  for (const [marketId, marketSignals] of byMarket) {
    if (marketSignals.length < 2) continue;

    // Majority vote on side
    const yesSigs = marketSignals.filter((s) => s.side === "YES");
    const noSigs = marketSignals.filter((s) => s.side === "NO");

    // Only emit if majority agrees (2/3 or 3/3)
    if (yesSigs.length === noSigs.length) continue;

    const majoritySignals = yesSigs.length > noSigs.length ? yesSigs : noSigs;
    const side = majoritySignals[0].side;
    const agreementRatio = majoritySignals.length / marketSignals.length;

    // Median fairYes across all models (not just majority)
    const sortedFairYes = marketSignals.map((s) => s.fairYes).sort((a, b) => a - b);
    const fairYes = sortedFairYes.length % 2 === 1
      ? sortedFairYes[Math.floor(sortedFairYes.length / 2)]
      : (sortedFairYes[sortedFairYes.length / 2 - 1] + sortedFairYes[sortedFairYes.length / 2]) / 2;

    // Ensemble confidence = agreement ratio × average confidence of majority
    const avgConfidence = majoritySignals.reduce((s, sig) => s + sig.confidence, 0) / majoritySignals.length;
    const confidence = agreementRatio * avgConfidence;

    // Use the majority side's average edge
    const avgEdge = majoritySignals.reduce((s, sig) => s + sig.edge, 0) / majoritySignals.length;

    // Use the first signal's market data (same market, same prices)
    const refSignal = marketSignals[0];

    const ensembleSig: Signal = {
      market: refSignal.market,
      fairYes,
      confidence,
      reasoning: `Ensemble consensus: ${majoritySignals.length}/${marketSignals.length} models agree on ${side}`,
      edge: avgEdge,
      side,
      marketPrice: side === "YES"
        ? parseFloat(refSignal.market.outcomePrices[0])
        : parseFloat(refSignal.market.outcomePrices[1]),
      tokenId: side === "YES" ? refSignal.market.clobTokenIds[0] : refSignal.market.clobTokenIds[1],
      informationBasis: refSignal.informationBasis,
      model: "ensemble",
    };

    ensembleSignals.push(ensembleSig);
    log.info(
      `[ensemble] ${side} "${refSignal.market.question.slice(0, 50)}..." — ${majoritySignals.length}/${marketSignals.length} agree, edge ${(Math.abs(avgEdge) * 100).toFixed(1)}%, conf ${(confidence * 100).toFixed(0)}%`
    );
  }

  return ensembleSignals;
}

// ─── Signal evaluation with shrinkage + category thresholds ───

export function evaluateSignal(
  market: GammaMarket,
  estimate: Stage2Estimate,
  category: MarketCategory
): Signal | null {
  const currentYes = parseFloat(market.outcomePrices[0]);
  const currentNo = parseFloat(market.outcomePrices[1]);

  // Apply calibration shrinkage
  const shrinkage = CALIBRATION.shrinkageFactor;
  const adjustedFairYes = currentYes + shrinkage * (estimate.fairYes - currentYes);

  const yesEdge = adjustedFairYes - currentYes;
  const noEdge = (1 - adjustedFairYes) - currentNo;

  let side: "YES" | "NO";
  let edge: number;
  let marketPrice: number;
  let tokenId: string;

  const bothHaveEdge = yesEdge > 0 && noEdge > 0;

  if (bothHaveEdge) {
    if (currentYes < 0.45 && currentNo > 0.55) {
      side = "YES"; edge = yesEdge; marketPrice = currentYes; tokenId = market.clobTokenIds[0];
    } else if (currentNo < 0.45 && currentYes > 0.55) {
      side = "NO"; edge = noEdge; marketPrice = currentNo; tokenId = market.clobTokenIds[1];
    } else {
      if (yesEdge > noEdge) {
        side = "YES"; edge = yesEdge; marketPrice = currentYes; tokenId = market.clobTokenIds[0];
      } else {
        side = "NO"; edge = noEdge; marketPrice = currentNo; tokenId = market.clobTokenIds[1];
      }
    }
  } else if (yesEdge > noEdge) {
    side = "YES"; edge = yesEdge; marketPrice = currentYes; tokenId = market.clobTokenIds[0];
  } else {
    side = "NO"; edge = noEdge; marketPrice = currentNo; tokenId = market.clobTokenIds[1];
  }

  const categoryMultiplier = CATEGORY_MULTIPLIERS[category] ?? 1.0;
  let effectiveEdge = edge * categoryMultiplier;

  if (marketPrice >= 0.40 && marketPrice <= 0.60) {
    effectiveEdge = effectiveEdge / TRADING.midPriceEdgePenalty;
  }

  if (effectiveEdge < TRADING.edgeThreshold) return null;
  if (estimate.confidence < ESTIMATION.stage2MinConfidence) return null;
  if (marketPrice < TRADING.minPriceThreshold || marketPrice > (1 - TRADING.minPriceThreshold)) return null;

  return {
    market,
    fairYes: adjustedFairYes,
    confidence: estimate.confidence,
    reasoning: estimate.reasoning,
    edge,
    side,
    marketPrice,
    tokenId,
    informationBasis: estimate.informationBasis,
  };
}
