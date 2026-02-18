import { OPENROUTER_API_KEY, RESEARCH } from "./config";
import { createLogger } from "./logger";

const log = createLogger("research");

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Cost tracking for research calls
let researchInputTokens = 0;
let researchOutputTokens = 0;

export function getResearchCostEstimate(): number {
  // Gemini Flash: $0.10/M input, $0.40/M output
  return (researchInputTokens / 1_000_000) * 0.1 + (researchOutputTokens / 1_000_000) * 0.4;
}

export function resetResearchCosts(): void {
  researchInputTokens = 0;
  researchOutputTokens = 0;
}

/**
 * Research a market by asking the model to reason about current information.
 * Uses OpenRouter API.
 *
 * Returns a text summary of relevant findings, or empty string on failure.
 */
export async function researchMarket(
  question: string,
  endDate: string,
  category: string
): Promise<string> {
  if (!RESEARCH.enabled) return "";

  const categoryHints = getCategorySearchHints(category, question);

  const prompt = `You are a research assistant for a prediction market trader. Provide CURRENT, REAL-TIME information relevant to this market:

MARKET QUESTION: "${question}"
RESOLUTION DATE: ${endDate}
TODAY: ${new Date().toISOString().split("T")[0]}
CATEGORY: ${category}

${categoryHints}

Provide a CONCISE summary (3-5 bullet points) of the key findings that would help estimate the probability of this market resolving YES.

Focus on FACTS, not opinions. Include specific numbers, dates, and sources when available.`;

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: RESEARCH.model,
        max_tokens: 1500,
        temperature: 0.01,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${body}`);
    }

    const data = await response.json() as any;
    researchInputTokens += data.usage?.prompt_tokens || 0;
    researchOutputTokens += data.usage?.completion_tokens || 0;

    const context = data.choices?.[0]?.message?.content?.trim() || "";
    if (context) {
      log.info(`Researched: "${question.slice(0, 60)}..." — ${context.length} chars`);
    } else {
      log.warn(`No research results for: "${question.slice(0, 60)}..."`);
    }

    return context;
  } catch (err) {
    log.error(`Research failed for: "${question.slice(0, 60)}..."`, err);
    return "";
  }
}

/**
 * Generate category-specific search hints to guide web research.
 */
function getCategorySearchHints(category: string, question: string): string {
  switch (category) {
    case "weather":
      return `SEARCH FOR: Current weather forecast for the specific location and date mentioned. Look for hourly forecasts, NWS/weather service data, and temperature predictions.`;
    case "sports":
      return `SEARCH FOR: Latest team news, injury reports, recent form/results, head-to-head records, and lineups for this match. Check sports news sites.`;
    case "crypto":
      return `SEARCH FOR: Current price of the cryptocurrency mentioned, recent price action, and any news events that could affect price in the next 48 hours.`;
    case "political":
      return `SEARCH FOR: Latest news about this political event/decision, statements from key players, legislative status, and expert analysis.`;
    case "speech":
      return `SEARCH FOR: Background on the speaker, event details, the speaker's recent use of the specific phrase/word, and the event agenda or topic.`;
    case "financial":
      return `SEARCH FOR: Current market data, recent price levels, analyst consensus, and upcoming economic events that could affect this market.`;
    default:
      return `SEARCH FOR: Any recent news or data directly relevant to this question.`;
  }
}
