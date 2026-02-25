import { createLogger } from "../logger";
import {
  NVIDIA_API_KEY, NVIDIA_ENDPOINT, NVIDIA_MODEL,
  OPENROUTER_API_KEY, OPENROUTER_ENDPOINT, OPENROUTER_MODELS,
  TRADING,
} from "../config";
import { Market, MarketBooks, Signal } from "../types";

const log = createLogger("llm-fair");

interface LLMEstimate {
  probability: number;
  confidence: number;
  reasoning: string;
}

// ── LLM call with fallback chain ──

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
        log.debug("OpenRouter estimate", { model, prob: estimate.probability });
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

function buildPrompt(market: Market): string {
  const closeDate = new Date(market.windowEnd).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  return `You are an independent prediction analyst. Your job is to estimate probabilities from first principles — do NOT simply agree with the market price.

Question: "${market.question}"
Category: ${market.category}
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

// ── Strategy entry point ──

export async function evaluateLLMFair(market: Market, books: MarketBooks): Promise<Signal | null> {
  // Skip crypto up/down (handled by vol-fair and latency)
  if (market.category === "crypto-updown") return null;

  const prompt = buildPrompt(market);

  // Try NVIDIA first, fallback to OpenRouter
  let estimate = await callNvidia(prompt);
  if (!estimate) {
    estimate = await callOpenRouter(prompt);
  }

  if (!estimate) {
    log.debug("No LLM estimate", { id: market.marketId.slice(0, 12) });
    return null;
  }

  if (estimate.confidence < TRADING.llmMinConfidence) {
    log.debug("LLM confidence too low", { confidence: estimate.confidence.toFixed(2) });
    return null;
  }

  const fairValue = estimate.probability;
  const yesEdge = fairValue - books.yes.bestAsk;
  const noEdge = (1 - fairValue) - books.no.bestAsk;

  let action: "buy-yes" | "buy-no";
  let edge: number;
  let entryPrice: number;

  if (yesEdge > noEdge && yesEdge > TRADING.llmMinEdge) {
    action = "buy-yes";
    edge = yesEdge;
    entryPrice = books.yes.bestAsk;
  } else if (noEdge > TRADING.llmMinEdge) {
    action = "buy-no";
    edge = noEdge;
    entryPrice = books.no.bestAsk;
  } else {
    return null;
  }

  log.info("LLM fair signal", {
    q: market.question.slice(0, 60),
    fair: fairValue.toFixed(3),
    action,
    entry: entryPrice.toFixed(3),
    edge: (edge * 100).toFixed(1) + "%",
    llmConf: estimate.confidence.toFixed(2),
  });

  return {
    strategy: "llm-fair",
    market,
    action,
    edge,
    confidence: estimate.confidence,
    fairValue,
    reasoning: `LLM fair: ${(fairValue * 100).toFixed(1)}% (conf=${(estimate.confidence * 100).toFixed(0)}%). ` +
      `${action} at ${entryPrice.toFixed(3)}, edge=${(edge * 100).toFixed(1)}%. ${estimate.reasoning}`,
  };
}
