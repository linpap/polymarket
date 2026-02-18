import { createLogger } from "../logger";
import { NVIDIA_API_KEY, NVIDIA_ENDPOINT, NVIDIA_MODEL, UPDOWN_TRADING, ASSET_TO_SYMBOL } from "./config";
import { UpDownMarket, ArbitrageSignal, MarketPrices, BinancePrice } from "./types";
import { getPrice } from "./binance-feed";
import { getBestPrices } from "./clob-reader";

const log = createLogger("arb-engine");

// ─── Strategy 1: Latency Arbitrage ───
// Binance price has moved significantly, Polymarket hasn't caught up yet

export function evaluateLatencyArb(
  market: UpDownMarket,
  prices: MarketPrices,
  binance: BinancePrice
): ArbitrageSignal | null {
  const now = Date.now();
  const timeRemaining = (market.windowEnd - now) / 1000; // seconds

  // Only trade near expiry for higher confidence
  if (timeRemaining > UPDOWN_TRADING.latencyTimeRemaining) return null;
  if (timeRemaining < 10) return null; // too close, might not fill

  // Determine if the asset's momentum aligns with market direction
  const change2m = computeChange2m(binance);
  const magnitude = Math.abs(change2m);

  if (magnitude < UPDOWN_TRADING.momentumThreshold) return null; // not enough movement

  // Is price moving in "up" or "down" direction?
  const priceDirection: "up" | "down" = change2m > 0 ? "up" : "down";

  // Market asks: "Will price be UP?" — YES means price went up
  // If Binance shows strong upward momentum and market is asking "up?"
  // and YES price is still cheap → buy YES (latency arb)
  let action: "buy-yes" | "buy-no";
  let entryPrice: number;
  let edge: number;

  if (market.direction === "up") {
    if (priceDirection === "up") {
      // Price is going up, market asks "will it be up?", buy YES
      action = "buy-yes";
      entryPrice = prices.yesBook.bestAsk;
      // Edge = how much we expect YES to be worth (near 1.0 if momentum is strong) minus what we'd pay
      edge = estimatedFinalValue(magnitude, timeRemaining) - entryPrice;
    } else {
      // Price going down, market asks "will it be up?", buy NO
      action = "buy-no";
      entryPrice = prices.noBook.bestAsk;
      edge = estimatedFinalValue(magnitude, timeRemaining) - entryPrice;
    }
  } else {
    // market.direction === "down" — YES means price went down
    if (priceDirection === "down") {
      action = "buy-yes";
      entryPrice = prices.yesBook.bestAsk;
      edge = estimatedFinalValue(magnitude, timeRemaining) - entryPrice;
    } else {
      action = "buy-no";
      entryPrice = prices.noBook.bestAsk;
      edge = estimatedFinalValue(magnitude, timeRemaining) - entryPrice;
    }
  }

  if (edge < UPDOWN_TRADING.latencyMinEdge) return null;

  // Confidence based on magnitude and time remaining
  const confidence = computeConfidence(magnitude, timeRemaining, entryPrice);

  return {
    type: "latency",
    market,
    edge,
    confidence,
    action,
    reasoning: `Binance ${market.asset} ${priceDirection} ${(change2m * 100).toFixed(2)}% in 2min. ` +
      `${action === "buy-yes" ? "YES" : "NO"} ask=${entryPrice.toFixed(3)}, ` +
      `edge=${(edge * 100).toFixed(1)}%, ${timeRemaining.toFixed(0)}s remaining`,
    binancePrice: binance.price,
  };
}

function computeChange2m(binance: BinancePrice): number {
  // Use the 1m change as proxy (we have 1m and 5m changes)
  // A stronger 1m move with consistent 5m trend is higher conviction
  return binance.change1m;
}

function estimatedFinalValue(magnitude: number, timeRemaining: number): number {
  // If price has moved significantly with little time remaining,
  // the outcome is likely locked in. Estimate the resolution value.
  // Larger moves + less time = higher estimated value near 1.0
  const timeDecay = Math.max(0, 1 - timeRemaining / 1800); // 0 at 30min, 1 at 0min
  const magnitudeScore = Math.min(1, magnitude / 0.001); // caps at 0.1% move (was 0.2%)
  const estimated = 0.5 + 0.45 * timeDecay * magnitudeScore;
  // Also give credit for pure magnitude even with time left
  const magnitudeBonus = Math.min(0.15, magnitude * 50);
  return Math.min(0.98, estimated + magnitudeBonus);
}

function computeConfidence(magnitude: number, timeRemaining: number, entryPrice: number): number {
  let conf = 0.40; // start lower (was 0.5)
  // More magnitude = more confidence
  if (magnitude > 0.0001) conf += 0.05;
  if (magnitude > 0.0003) conf += 0.05;
  if (magnitude > 0.0005) conf += 0.05;
  if (magnitude > 0.001) conf += 0.1;
  if (magnitude > 0.003) conf += 0.1;
  if (magnitude > 0.005) conf += 0.1;
  // Less time remaining = more locked in
  if (timeRemaining < 1800) conf += 0.03;
  if (timeRemaining < 600) conf += 0.05;
  if (timeRemaining < 300) conf += 0.05;
  if (timeRemaining < 120) conf += 0.05;
  if (timeRemaining < 60) conf += 0.1;
  // Cheaper entry = more upside
  if (entryPrice < 0.80) conf += 0.05;
  if (entryPrice < 0.60) conf += 0.05;
  if (entryPrice < 0.40) conf += 0.05;
  return Math.min(0.95, conf);
}

// ─── Strategy 2: Complete-Set Arbitrage ───
// YES_ask + NO_ask < $0.97 → guaranteed profit

export function evaluateCompleteSet(
  market: UpDownMarket,
  prices: MarketPrices
): ArbitrageSignal | null {
  const combined = prices.combinedAsk;

  if (combined >= UPDOWN_TRADING.completeSetThreshold) return null;

  const edge = 1.0 - combined; // guaranteed profit per $1 of resolution
  const confidence = 0.99; // nearly guaranteed (only risk is execution failure)

  return {
    type: "complete-set",
    market,
    edge,
    confidence,
    action: "buy-both",
    reasoning: `Complete-set arb: YES ask=${prices.yesBook.bestAsk.toFixed(3)} + ` +
      `NO ask=${prices.noBook.bestAsk.toFixed(3)} = ${combined.toFixed(3)} < $0.97. ` +
      `Guaranteed ${(edge * 100).toFixed(1)}% profit`,
  };
}

// ─── Strategy 3: NVIDIA GLM Confirmation ───
// For ambiguous signals (60-75% confidence), consult the LLM

export async function confirmWithGLM(signal: ArbitrageSignal): Promise<{
  confirmed: boolean;
  probability: number;
  reasoning: string;
}> {
  if (!NVIDIA_API_KEY) {
    log.warn("No NVIDIA API key — skipping GLM confirmation");
    return { confirmed: false, probability: 0.5, reasoning: "No API key" };
  }

  const binance = getPrice(ASSET_TO_SYMBOL[signal.market.asset] || "btcusdt");
  const timeRemaining = Math.round((signal.market.windowEnd - Date.now()) / 1000);

  const prompt = `You are a crypto price prediction expert. Analyze this 5-minute window market:

Market: "${signal.market.question}"
Asset: ${signal.market.asset}
Current Binance price: $${binance?.price?.toLocaleString() ?? "unknown"}
1-min price change: ${binance ? (binance.change1m * 100).toFixed(3) : "unknown"}%
5-min price change: ${binance ? (binance.change5m * 100).toFixed(3) : "unknown"}%
Momentum: ${binance?.momentum ?? "unknown"}
Time remaining in window: ${timeRemaining} seconds
Current YES price: ${signal.market.currentYes.toFixed(3)}
Current NO price: ${signal.market.currentNo.toFixed(3)}

Our signal: ${signal.action} with ${(signal.confidence * 100).toFixed(0)}% confidence, edge=${(signal.edge * 100).toFixed(1)}%

Question: Based on the current price momentum and time remaining, what is the probability that "${signal.market.question}" resolves YES?

Respond with ONLY a JSON object:
{"probability": 0.XX, "confidence": 0.XX, "reasoning": "brief explanation"}`;

  try {
    const resp = await fetch(NVIDIA_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.error("NVIDIA GLM API error", { status: resp.status, body: errText.slice(0, 200) });
      return { confirmed: false, probability: 0.5, reasoning: `API error: ${resp.status}` };
    }

    const data = await resp.json() as any;
    const content = data.choices?.[0]?.message?.content || "";

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      log.warn("GLM returned non-JSON response", { content: content.slice(0, 200) });
      return { confirmed: false, probability: 0.5, reasoning: "Failed to parse GLM response" };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const probability = parseFloat(parsed.probability) || 0.5;
    const reasoning = parsed.reasoning || "No reasoning provided";

    // Confirm if GLM probability aligns with our signal
    const glmFavorsYes = probability > 0.55;
    const glmFavorsNo = probability < 0.45;
    const ourSideIsYes = signal.action === "buy-yes";

    const confirmed = ourSideIsYes ? glmFavorsYes : glmFavorsNo;

    log.info("GLM confirmation", {
      probability: probability.toFixed(2),
      confirmed,
      reasoning: reasoning.slice(0, 100),
    });

    return { confirmed, probability, reasoning };
  } catch (e) {
    log.error("GLM confirmation failed", (e as Error).message);
    return { confirmed: false, probability: 0.5, reasoning: `Error: ${(e as Error).message}` };
  }
}

// ─── Main evaluation pipeline ───

export async function evaluateMarket(market: UpDownMarket): Promise<ArbitrageSignal | null> {
  const symbol = ASSET_TO_SYMBOL[market.asset];
  if (!symbol) {
    log.debug("No Binance symbol for asset", { asset: market.asset });
    return null;
  }

  const binance = getPrice(symbol);
  if (!binance) {
    log.debug("No Binance price data yet for", { symbol });
    return null;
  }

  // Get fresh order book
  let prices: MarketPrices;
  try {
    prices = await getBestPrices(market);
  } catch (e) {
    log.error("Failed to get prices for market", { marketId: market.marketId });
    return null;
  }

  // Update market with live prices
  market.currentYes = prices.yesBook.midpoint;
  market.currentNo = prices.noBook.midpoint;

  // Strategy 2: Complete-set (check first — guaranteed profit)
  const completeSetSignal = evaluateCompleteSet(market, prices);
  if (completeSetSignal) {
    log.info("COMPLETE-SET ARB FOUND", {
      asset: market.asset,
      combined: prices.combinedAsk.toFixed(3),
      edge: (completeSetSignal.edge * 100).toFixed(1) + "%",
    });
    return completeSetSignal;
  }

  // Strategy 1: Latency arb
  const latencySignal = evaluateLatencyArb(market, prices, binance);
  if (!latencySignal) return null;

  // High confidence → trade immediately
  if (latencySignal.confidence >= UPDOWN_TRADING.glmConfidenceHigh) {
    log.info("HIGH-CONFIDENCE LATENCY ARB", {
      asset: market.asset,
      action: latencySignal.action,
      edge: (latencySignal.edge * 100).toFixed(1) + "%",
      confidence: (latencySignal.confidence * 100).toFixed(0) + "%",
    });
    return latencySignal;
  }

  // Medium confidence → consult GLM
  if (latencySignal.confidence >= UPDOWN_TRADING.glmConfidenceLow) {
    const glm = await confirmWithGLM(latencySignal);
    latencySignal.glmConfirmed = glm.confirmed;

    if (glm.confirmed) {
      latencySignal.reasoning += ` | GLM confirmed (p=${glm.probability.toFixed(2)}): ${glm.reasoning.slice(0, 80)}`;
      log.info("GLM-CONFIRMED LATENCY ARB", {
        asset: market.asset,
        action: latencySignal.action,
        edge: (latencySignal.edge * 100).toFixed(1) + "%",
      });
      return latencySignal;
    } else {
      log.info("GLM rejected signal", {
        asset: market.asset,
        glmProbability: glm.probability.toFixed(2),
        reason: glm.reasoning.slice(0, 80),
      });
      return null; // skip
    }
  }

  // Low confidence → skip
  return null;
}
