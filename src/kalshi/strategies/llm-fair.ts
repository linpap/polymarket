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

  return `You are an independent prediction analyst. Your job is to estimate probabilities from first principles — do NOT simply agree with the market price.

Question: "${market.title}"
${market.subtitle ? `Context: "${market.subtitle}"` : ""}
Category: ${category}
Resolution date: ${closeDate}

IMPORTANT: Form your OWN estimate FIRST based on:
- Historical base rates for similar events
- Current geopolitical/economic context (today is February 2026)
- Logical reasoning about what needs to happen for YES to resolve
- Time pressure: how much could change before ${closeDate}?

Do NOT anchor to any price. Think step by step, then give your independent probability.

Respond with ONLY a JSON object:
{"probability": 0.XX, "confidence": 0.XX, "reasoning": "your step-by-step reasoning in 2-3 sentences"}

probability = your estimated chance this resolves YES (0.0 to 1.0)
confidence = how confident you are (0.5 = coin flip, 0.9 = very sure)`;
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

  log.debug("LLM estimate received", {
    ticker: market.ticker,
    probability: estimate.probability.toFixed(3),
    confidence: estimate.confidence.toFixed(2),
    yes_ask: market.yes_ask.toFixed(3),
    no_ask: market.no_ask.toFixed(3),
    reasoning: estimate.reasoning.slice(0, 60),
  });

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

  log.debug("Edge calculation", {
    ticker: market.ticker,
    fairValue: fairValue.toFixed(3),
    yesEdge: (yesEdge * 100).toFixed(1) + "%",
    noEdge: (noEdge * 100).toFixed(1) + "%",
    minEdge: (KALSHI_TRADING.llmFairMinEdge * 100).toFixed(1) + "%",
  });

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
    log.debug("No edge found", { ticker: market.ticker });
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
