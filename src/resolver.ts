import axios from "axios";
import { GAMMA_API } from "./config";
import { PaperTrade } from "./types";
import { createLogger } from "./logger";

const log = createLogger("resolver");

interface GammaMarketResolution {
  id: string;
  closed: boolean;
  active: boolean;
  outcomePrices: string; // JSON: '["1","0"]' means YES won
}

/**
 * Check unresolved paper trades against Gamma API for resolutions.
 * Returns updated trades with resolution data filled in.
 */
export async function checkResolutions(trades: PaperTrade[]): Promise<PaperTrade[]> {
  const unresolved = trades.filter((t) => !t.resolved);
  if (unresolved.length === 0) return trades;

  // Batch fetch by market IDs (deduplicate)
  const marketIds = [...new Set(unresolved.map((t) => t.marketId))];
  const resolutions = await fetchMarketStatuses(marketIds);

  let newResolutions = 0;

  for (const trade of trades) {
    if (trade.resolved) continue;

    const status = resolutions.get(trade.marketId);
    if (!status) continue;

    // A market is resolved when it's closed and prices are 1/0 (or very close)
    if (!status.closed) continue;

    const prices = parseOutcomePrices(status.outcomePrices);
    if (!prices) continue;

    const yesPrice = prices[0];
    const noPrice = prices[1];

    // Resolved: YES price is ~1 or ~0
    if (yesPrice > 0.95) {
      trade.resolved = true;
      trade.resolution = "YES";
      trade.resolvedAt = Date.now();
      trade.pnl = calculatePnl(trade, "YES");
      newResolutions++;
    } else if (noPrice > 0.95) {
      trade.resolved = true;
      trade.resolution = "NO";
      trade.resolvedAt = Date.now();
      trade.pnl = calculatePnl(trade, "NO");
      newResolutions++;
    }
    // Otherwise closed but not cleanly resolved (e.g. refunded) — skip
  }

  if (newResolutions > 0) {
    log.info(`${newResolutions} paper trades resolved`);
  }

  return trades;
}

/**
 * Check if any paper trades are on markets past their end date
 * that haven't resolved yet — these might need manual review.
 */
export function flagExpiredUnresolved(trades: PaperTrade[]): PaperTrade[] {
  const now = Date.now();
  const stale: PaperTrade[] = [];

  for (const trade of trades) {
    if (trade.resolved) continue;
    const endDate = new Date(trade.endDate).getTime();
    if (endDate < now) {
      stale.push(trade);
    }
  }

  if (stale.length > 0) {
    log.warn(`${stale.length} trades past end date but unresolved`);
    for (const t of stale) {
      log.warn(`  "${t.question}" — ended ${t.endDate}`);
    }
  }

  return stale;
}

function calculatePnl(trade: PaperTrade, resolution: "YES" | "NO"): number {
  // If we bet on the winning side, we get $1 per share
  // If we bet on the losing side, we get $0
  const won = trade.side === resolution;
  const proceeds = won ? trade.hypotheticalShares * 1.0 : 0;
  return proceeds - trade.hypotheticalSize;
}

async function fetchMarketStatuses(
  marketIds: string[]
): Promise<Map<string, GammaMarketResolution>> {
  const map = new Map<string, GammaMarketResolution>();

  // Fetch in batches of 20 to avoid URL length limits
  for (let i = 0; i < marketIds.length; i += 20) {
    const batch = marketIds.slice(i, i + 20);

    try {
      const { data } = await axios.get<GammaMarketResolution[]>(
        `${GAMMA_API}/markets`,
        {
          params: {
            id: batch.join(","),
            limit: batch.length,
          },
        }
      );

      for (const market of data) {
        map.set(market.id, market);
      }
    } catch (err) {
      log.error(`Failed to fetch market statuses for batch starting at ${i}`, err);
    }
  }

  return map;
}

function parseOutcomePrices(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    return parsed.map(Number);
  } catch {
    return null;
  }
}
