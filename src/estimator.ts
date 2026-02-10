import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, ESTIMATION } from "./config";
import { GammaMarket, Stage1Estimate, Stage2Estimate } from "./types";
import { createLogger } from "./logger";

const log = createLogger("estimator");

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Cost tracking (approximate, based on Haiku 4.5 pricing: $1/$5 per M tokens)
let sessionInputTokens = 0;
let sessionOutputTokens = 0;

export function getApiCostEstimate(): number {
  // Haiku 4.5: $1/M input, $5/M output
  return (sessionInputTokens / 1_000_000) * 1 + (sessionOutputTokens / 1_000_000) * 5;
}

export function resetSessionCosts(): void {
  sessionInputTokens = 0;
  sessionOutputTokens = 0;
}

// ─── Stage 1: Batch screening ───

export async function batchScreen(
  markets: GammaMarket[]
): Promise<Stage1Estimate[]> {
  const results: Stage1Estimate[] = [];

  for (let i = 0; i < markets.length; i += ESTIMATION.batchSize) {
    const batch = markets.slice(i, i + ESTIMATION.batchSize);
    const batchResults = await screenBatch(batch);
    results.push(...batchResults);
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

  const prompt = `You are a prediction market analyst. For each market below, estimate the TRUE probability of "Yes" based on your knowledge. Be calibrated — don't anchor to the current market price.

Markets:
${marketList.map((m) => `${m.idx}. [${m.id}] "${m.q}" (current Yes price: ${m.yes})`).join("\n")}

Respond with ONLY a JSON array of objects: [{"idx": 0, "fair": 0.XX}, ...]
- "fair" is your estimated true probability of Yes (0.01 to 0.99)
- Include ALL markets, one per entry
- No commentary, just the JSON array`;

  try {
    const response = await anthropic.messages.create({
      model: ESTIMATION.stage1Model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    sessionInputTokens += response.usage.input_tokens;
    sessionOutputTokens += response.usage.output_tokens;

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      log.warn("Stage 1: Failed to parse batch response");
      return [];
    }

    const parsed: { idx: number; fair: number }[] = JSON.parse(jsonMatch[0]);

    return parsed
      .map((p) => {
        const market = batch[p.idx];
        if (!market) return null;
        const currentYes = parseFloat(market.outcomePrices[0]);
        const fairYes = Math.max(0.01, Math.min(0.99, p.fair));
        return {
          marketId: market.id,
          question: market.question,
          fairYes,
          currentYes,
          potentialEdge: Math.abs(fairYes - currentYes),
        };
      })
      .filter((x): x is Stage1Estimate => x !== null);
  } catch (err) {
    log.error("Stage 1 batch screening failed", err);
    return [];
  }
}

// ─── Stage 2: Deep analysis ───

export async function deepAnalyze(
  market: GammaMarket,
  currentYes: number
): Promise<Stage2Estimate | null> {
  const prompt = `You are an expert prediction market analyst. Analyze this market and provide your probability estimate.

MARKET: "${market.question}"
DESCRIPTION: ${market.description || "No description available"}
CURRENT YES PRICE: ${currentYes}
END DATE: ${market.endDate}
CURRENT DATE: ${new Date().toISOString().split("T")[0]}

Analyze step by step:
1. What are the key factors that determine this outcome?
2. What is the base rate for events like this?
3. What recent developments are relevant?
4. Where might the market be wrong?

Then provide your estimate in this EXACT JSON format at the end:
{"fairYes": 0.XX, "confidence": 0.XX, "keyFactors": ["factor1", "factor2", "factor3"]}

- fairYes: your true probability estimate (0.01 to 0.99)
- confidence: how confident you are in your estimate vs the market (0.0 to 1.0)
  - 0.3 = low confidence, market probably knows better
  - 0.5 = moderate, you have some edge
  - 0.7+ = high confidence, strong reasons the market is wrong
- keyFactors: 2-4 key reasons for your estimate`;

  try {
    const response = await anthropic.messages.create({
      model: ESTIMATION.stage2Model,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    sessionInputTokens += response.usage.input_tokens;
    sessionOutputTokens += response.usage.output_tokens;

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Extract reasoning (everything before JSON)
    const jsonMatch = text.match(/\{[\s\S]*"fairYes"[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn(`Stage 2: Failed to parse response for ${market.id}`);
      return null;
    }

    const reasoning = text.substring(0, text.indexOf(jsonMatch[0])).trim();
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      marketId: market.id,
      question: market.question,
      fairYes: Math.max(0.01, Math.min(0.99, parsed.fairYes)),
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      reasoning,
      keyFactors: parsed.keyFactors || [],
    };
  } catch (err) {
    log.error(`Stage 2 analysis failed for ${market.id}`, err);
    return null;
  }
}
