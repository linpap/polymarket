import { createLogger } from "../../logger";
import {
  NVIDIA_API_KEY, NVIDIA_ENDPOINT, NVIDIA_MODEL,
  OPENROUTER_API_KEY, OPENROUTER_ENDPOINT, OPENROUTER_MODELS,
  KALSHI_TRADING,
} from "../config";
import { KalshiMarket, KalshiSignal, KalshiCategory } from "../types";
import { detectCategory } from "../scanner";

const log = createLogger("llm-fair");

// ─── LLM call with fallback chain ───

interface LLMEstimate {
  probability: number;
  confidence: number;
  reasoning: string;
}

async function callNvidia(prompt: string): Promise<LLMEstimate | null> {
  if (!NVIDIA_API_KEY) return null;

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
        max_tokens: 300,
      }),
    });

    if (!resp.ok) {
      log.debug("NVIDIA API error", { status: resp.status });
      return null;
    }

    const data = await resp.json() as any;
    const content = data.choices?.[0]?.message?.content || "";
    return parseEstimate(content);
  } catch (e) {
    log.debug("NVIDIA call failed", (e as Error).message);
    return null;
  }
}

async function callOpenRouter(prompt: string): Promise<LLMEstimate | null> {
  if (!OPENROUTER_API_KEY) return null;

  for (const model of OPENROUTER_MODELS) {
    try {
      const resp = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://github.com/polymarket-agent",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 300,
        }),
      });

      if (!resp.ok) continue;

      const data = await resp.json() as any;
      const content = data.choices?.[0]?.message?.content || "";
      const estimate = parseEstimate(content);
      if (estimate) {
        log.debug("OpenRouter estimate from", { model, probability: estimate.probability });
        return estimate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function parseEstimate(content: string): LLMEstimate | null {
  try {
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const probability = parseFloat(parsed.probability);
    const confidence = parseFloat(parsed.confidence) || 0.5;
    const reasoning = String(parsed.reasoning || "").slice(0, 200);

    if (isNaN(probability) || probability < 0 || probability > 1) return null;

    return { probability, confidence, reasoning };
  } catch {
    return null;
  }
}

// ─── Build LLM prompt ───

function buildPrompt(market: KalshiMarket, category: KalshiCategory): string {
  const closeDate = new Date(market.close_time).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return `You are a prediction market analyst. Estimate the probability that this Kalshi market resolves YES.

Market: "${market.title}"
${market.subtitle ? `Details: "${market.subtitle}"` : ""}
Category: ${category}
Close date: ${closeDate}
Current YES price: ${(market.yes_ask * 100).toFixed(0)} cents
Current NO price: ${(market.no_ask * 100).toFixed(0)} cents
Volume: ${market.volume_24h} contracts (24h)

Consider:
- Base rates and historical data for similar events
- Current market conditions and recent trends
- Time remaining until resolution
- The market price as a wisdom-of-crowds estimate

Be calibrated. If you are unsure, your probability should be close to the market price.
Only deviate significantly if you have strong reasoning.

Respond with ONLY a JSON object:
{"probability": 0.XX, "confidence": 0.XX, "reasoning": "1-2 sentence explanation"}

probability = your estimated chance of YES resolution (0-1)
confidence = how confident you are in your estimate (0-1, where 0.5 = unsure, 0.9 = very sure)`;
}

// ─── Strategy entry point ───

export async function evaluateLLMFair(market: KalshiMarket): Promise<KalshiSignal | null> {
  const category = detectCategory(market);

  // Skip crypto markets (handled by crypto-price strategy)
  if (category === "crypto") return null;

  const prompt = buildPrompt(market, category);

  // Try NVIDIA first, fallback to OpenRouter
  let estimate = await callNvidia(prompt);
  if (!estimate) {
    estimate = await callOpenRouter(prompt);
  }

  if (!estimate) {
    log.debug("No LLM estimate for", { ticker: market.ticker });
    return null;
  }

  // Reject low-confidence estimates
  if (estimate.confidence < KALSHI_TRADING.llmMinConfidence) {
    log.debug("LLM confidence too low", {
      ticker: market.ticker,
      confidence: estimate.confidence.toFixed(2),
    });
    return null;
  }

  const fairValue = estimate.probability;

  // Check both sides
  const yesEdge = fairValue - market.yes_ask;
  const noEdge = (1 - fairValue) - market.no_ask;

  let side: "yes" | "no";
  let edge: number;
  let marketPrice: number;

  if (yesEdge > noEdge && yesEdge > KALSHI_TRADING.llmFairMinEdge) {
    side = "yes";
    edge = yesEdge;
    marketPrice = market.yes_ask;
  } else if (noEdge > KALSHI_TRADING.llmFairMinEdge) {
    side = "no";
    edge = noEdge;
    marketPrice = market.no_ask;
  } else {
    return null;
  }

  log.info("LLM fair value signal", {
    ticker: market.ticker,
    category,
    fairValue: fairValue.toFixed(3),
    marketYes: market.yes_ask.toFixed(3),
    side,
    edge: (edge * 100).toFixed(1) + "%",
    llmConfidence: estimate.confidence.toFixed(2),
  });

  return {
    strategy: "llm-fair",
    market,
    side,
    fairValue,
    marketPrice,
    edge,
    confidence: estimate.confidence,
    categoryMultiplier: 1.0, // will be overridden by evaluator
    reasoning: `LLM fair value: ${(fairValue * 100).toFixed(1)}% (conf=${(estimate.confidence * 100).toFixed(0)}%). ` +
      `Market ${side.toUpperCase()} ask: ${(marketPrice * 100).toFixed(1)}%. ` +
      `Edge: ${(edge * 100).toFixed(1)}%. ${estimate.reasoning}`,
  };
}
