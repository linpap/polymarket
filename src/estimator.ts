import { ESTIMATION, OPENROUTER_API_KEY } from "./config";
import { GammaMarket, Stage1Estimate, Stage2Estimate } from "./types";
import { createLogger } from "./logger";

const log = createLogger("estimator");

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // All free models — $0 cost
  "deepseek/deepseek-r1-0528:free": { input: 0, output: 0 },
  "google/gemma-3-27b-it:free": { input: 0, output: 0 },
  "nousresearch/hermes-3-llama-3.1-405b:free": { input: 0, output: 0 },
};

interface TokenUsage {
  input: number;
  output: number;
}

const sessionTokens: Record<string, TokenUsage> = {};

function trackTokens(model: string, input: number, output: number): void {
  if (!sessionTokens[model]) {
    sessionTokens[model] = { input: 0, output: 0 };
  }
  sessionTokens[model].input += input;
  sessionTokens[model].output += output;
}

export function getApiCostEstimate(): number {
  let total = 0;
  for (const [model, usage] of Object.entries(sessionTokens)) {
    const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
    total += (usage.input / 1_000_000) * pricing.input + (usage.output / 1_000_000) * pricing.output;
  }
  return total;
}

export function resetSessionCosts(): void {
  for (const key of Object.keys(sessionTokens)) {
    delete sessionTokens[key];
  }
}

async function callOpenRouter(prompt: string, model: string, maxTokens: number = 1500, lowReasoning: boolean = false): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const body: any = {
      model,
      max_tokens: maxTokens,
      temperature: 0.01,
      messages: [{ role: "user", content: prompt }],
    };
    // For reasoning models (e.g. DeepSeek R1), reduce thinking budget
    if (lowReasoning) {
      body.reasoning = { effort: "low" };
    }

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429 && attempt < maxRetries) {
      const wait = (attempt + 1) * 5000; // 5s, 10s, 15s backoff
      log.warn(`Rate limited (429) on ${model}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${body}`);
    }

    const data = await response.json() as any;
    let text = data.choices?.[0]?.message?.content || "";
    // Strip <think>...</think> blocks from reasoning models (e.g. DeepSeek R1)
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    const inputTokens = data.usage?.prompt_tokens || Math.round(prompt.length / 4);
    const outputTokens = data.usage?.completion_tokens || Math.round(text.length / 4);

    return { text, inputTokens, outputTokens };
  }

  throw new Error(`OpenRouter: exhausted ${maxRetries} retries on ${model}`);
}

export async function batchScreen(
  markets: GammaMarket[]
): Promise<Stage1Estimate[]> {
  const results: Stage1Estimate[] = [];

  for (let i = 0; i < markets.length; i += ESTIMATION.batchSize) {
    const batch = markets.slice(i, i + ESTIMATION.batchSize);
    const batchResults = await screenBatch(batch);
    results.push(...batchResults);
    // Delay between batches to respect free-tier rate limits
    if (i + ESTIMATION.batchSize < markets.length) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return results;
}

async function screenBatch(batch: GammaMarket[]): Promise<Stage1Estimate[]> {
  const marketList = batch.map((m, idx) => ({
    idx,
    id: m.id,
    q: m.question,
    yes: parseFloat(m.outcomePrices[0]),
  }));

  const prompt = `Output ONLY valid JSON array like [{"idx":0,"fair":0.5},{"idx":1,"fair":0.6}]. No text.\n` +
    marketList.map((m, i) => `${i}: ${m.q.substring(0,50)} cur:${m.yes}`).join("\n");

  // Try each model in the fallback chain until one succeeds
  const models = ESTIMATION.stage1Models;
  let response = "";
  let usedModel = models[0];

  for (const model of models) {
    try {
      const isReasoning = model.includes("deepseek") || model.includes("r1");
      const result = await callOpenRouter(prompt + "\nJSON:", model, isReasoning ? 16000 : 1500, isReasoning);
      if (result.text.trim().length > 0) {
        response = result.text;
        usedModel = model;
        trackTokens(model, result.inputTokens, result.outputTokens);
        break;
      }
      log.warn(`Stage 1: Empty response from ${model}, trying next`);
    } catch (err: any) {
      log.warn(`Stage 1: ${model} failed (${err?.message?.slice(0, 80)}), trying next`);
    }
  }

  try {
    log.info(`Stage1 [${usedModel.split("/")[1]?.split(":")[0] || usedModel}]: ${response.substring(0, 100)}`);

    let jsonText = response.trim();

    if (!jsonText.startsWith('[')) {
      const matches: string[] = [];
      let depth = 0;
      let start = -1;

      for (let i = 0; i < jsonText.length; i++) {
        if (jsonText[i] === '{') {
          if (depth === 0) start = i;
          depth++;
        } else if (jsonText[i] === '}') {
          depth--;
          if (depth === 0 && start >= 0) {
            matches.push(jsonText.substring(start, i + 1));
            start = -1;
          }
        }
      }

      if (matches.length > 0) {
        jsonText = '[' + matches.join(',') + ']';
      } else {
        jsonText = '[' + jsonText + ']';
      }
    }

    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      log.warn("Stage 1: Response is not an array");
      return [];
    }

    return parsed
      .map((p: any) => {
        const market = batch[p.idx];
        if (!market) return null;
        const currentYes = parseFloat(market.outcomePrices[0]);
        const fairYes = Math.max(0.01, Math.min(0.99, parseFloat(p.fair) || 0.5));
        return {
          marketId: market.id,
          question: market.question,
          fairYes,
          currentYes,
          potentialEdge: Math.abs(fairYes - currentYes),
        };
      })
      .filter((x): x is Stage1Estimate => x !== null);
  } catch (err: any) {
    log.error(`Stage 1 batch screening failed: ${err?.message || err}`);
    return [];
  }
}

export async function deepAnalyze(
  market: GammaMarket,
  currentYes: number,
  researchContext?: string,
  model?: string
): Promise<Stage2Estimate | null> {
  const contextSection = researchContext
    ? `\nWEB RESEARCH:\n${researchContext}\n`
    : "";

  const prompt = `You are a prediction market analyst. Estimate the probability for this market.

Market: "${market.question}"
Current YES price: ${currentYes}
End date: ${market.endDate}
${contextSection}
IMPORTANT: Reply with ONLY this JSON object, no other text:
{"fairYes":0.XX,"confidence":0.XX,"informationBasis":"informed","keyFactors":["factor1","factor2"]}

Where fairYes is your probability estimate (0.01-0.99), confidence is how sure you are (0.0-1.0), and informationBasis is one of "concrete", "informed", or "speculative".

JSON:`;

  const useModel = model || ESTIMATION.stage2Model;

  try {
    const { text: response, inputTokens, outputTokens } = await callOpenRouter(prompt, useModel, 500);
    trackTokens(useModel, inputTokens, outputTokens);

    if (!response || response.trim().length === 0) {
      log.warn(`Stage 2: Empty response for ${market.id} from ${useModel}`);
      return null;
    }

    // Strip markdown code blocks
    let jsonText = response.trim()
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "");

    // Try multiple JSON extraction strategies
    let parsed: any = null;

    // Strategy 1: Find {..."fairYes"...} with non-greedy match
    const match1 = jsonText.match(/\{[^{}]*"fairYes"\s*:\s*[\d.]+[^{}]*\}/);
    if (match1) {
      try { parsed = JSON.parse(match1[0]); } catch {}
    }

    // Strategy 2: Greedy match for nested objects
    if (!parsed) {
      const match2 = jsonText.match(/\{[\s\S]*?"fairYes"[\s\S]*?\}/);
      if (match2) {
        try { parsed = JSON.parse(match2[0]); } catch {}
      }
    }

    // Strategy 3: Try to extract numbers directly
    if (!parsed) {
      const fairMatch = jsonText.match(/fairYes["\s:]+(\d+\.?\d*)/);
      const confMatch = jsonText.match(/confidence["\s:]+(\d+\.?\d*)/);
      if (fairMatch) {
        parsed = {
          fairYes: parseFloat(fairMatch[1]),
          confidence: confMatch ? parseFloat(confMatch[1]) : 0.3,
          informationBasis: "speculative",
          keyFactors: [],
        };
      }
    }

    if (!parsed || typeof parsed.fairYes !== "number") {
      log.warn(`Stage 2: Failed to parse response for ${market.id} (${response.slice(0, 80)}...)`);
      return null;
    }

    const validBases = ["concrete", "informed", "speculative"] as const;
    const basis = validBases.includes(parsed.informationBasis)
      ? parsed.informationBasis
      : "speculative";

    return {
      marketId: market.id,
      question: market.question,
      fairYes: Math.max(0.01, Math.min(0.99, parsed.fairYes)),
      confidence: Math.max(0, Math.min(1, parsed.confidence || 0.3)),
      reasoning: "",
      keyFactors: parsed.keyFactors || [],
      informationBasis: basis,
    };
  } catch (err: any) {
    const msg = err?.message || err?.toString?.() || JSON.stringify(err);
    log.error(`Stage 2 analysis failed for ${market.id}: ${msg}`);
    return null;
  }
}
