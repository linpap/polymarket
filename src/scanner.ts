import axios from "axios";
import { GAMMA_API, TRADING } from "./config";
import { GammaMarket } from "./types";
import { createLogger } from "./logger";

const log = createLogger("scanner");

const PAGE_SIZE = 100;

interface GammaMarketsResponse {
  id: string;
  question: string;
  description: string;
  conditionId: string;
  slug: string;
  endDate: string;
  liquidity: string;
  volume: string;
  outcomes: string;       // JSON string: '["Yes","No"]'
  outcomePrices: string;  // JSON string: '["0.65","0.35"]'
  clobTokenIds: string;   // JSON string: '["123...","456..."]'
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  negRisk?: boolean;
}

function parseMarket(raw: GammaMarketsResponse): GammaMarket | null {
  try {
    const outcomes = JSON.parse(raw.outcomes || "[]");
    const outcomePrices = JSON.parse(raw.outcomePrices || "[]");
    const clobTokenIds = JSON.parse(raw.clobTokenIds || "[]");

    // Only binary markets (Yes/No)
    if (outcomes.length !== 2) return null;
    if (clobTokenIds.length !== 2) return null;
    if (!outcomePrices[0] || !outcomePrices[1]) return null;

    return {
      id: raw.id,
      question: raw.question,
      description: raw.description || "",
      conditionId: raw.conditionId,
      slug: raw.slug,
      endDate: raw.endDate,
      liquidity: raw.liquidity,
      volume: raw.volume,
      outcomes,
      outcomePrices,
      clobTokenIds,
      active: raw.active,
      closed: raw.closed,
      archived: raw.archived,
      acceptingOrders: raw.acceptingOrders,
      enableOrderBook: raw.enableOrderBook,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a single market's current data by ID.
 * Used for staleness checks between Stage 1 and Stage 2.
 */
export async function fetchMarketById(marketId: string): Promise<GammaMarket | null> {
  try {
    const { data } = await axios.get<GammaMarketsResponse>(
      `${GAMMA_API}/markets/${marketId}`
    );
    if (!data) return null;
    return parseMarket(data);
  } catch {
    log.debug(`Failed to fetch market ${marketId}`);
    return null;
  }
}

export async function scanMarkets(): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  let offset = 0;
  const maxPages = 20; // Scan up to 2000 markets for max coverage

  for (let page = 0; page < maxPages; page++) {
    log.debug(`Fetching markets page ${page + 1} (offset=${offset})`);

    const { data } = await axios.get<GammaMarketsResponse[]>(
      `${GAMMA_API}/markets`,
      {
        params: {
          active: true,
          closed: false,
          liquidity_num_min: TRADING.minLiquidity,
          end_date_max: new Date(
            Date.now() + TRADING.maxDaysToResolution * 24 * 60 * 60 * 1000
          ).toISOString(),
          limit: PAGE_SIZE,
          offset,
          order: "liquidity",
          ascending: false,
        },
      }
    );

    if (!data || data.length === 0) break;

    const maxEndDate = Date.now() + TRADING.maxDaysToResolution * 24 * 60 * 60 * 1000;

    for (const raw of data) {
      if (!raw.enableOrderBook || !raw.acceptingOrders) continue;

      // Require an end date and skip markets that resolve too far out
      if (!raw.endDate) continue;
      const endTime = new Date(raw.endDate).getTime();
      if (endTime > maxEndDate || endTime < Date.now()) continue;

      const market = parseMarket(raw);
      if (market) {
        allMarkets.push(market);
      }
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  log.info(`Scanned ${allMarkets.length} tradeable binary markets`);
  return allMarkets;
}
