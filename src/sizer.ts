import { TRADING } from "./config";
import { Signal, SizedPosition, OpenPosition } from "./types";
import { createLogger } from "./logger";

const log = createLogger("sizer");

/**
 * Kelly Criterion position sizing.
 *
 * Full Kelly: f* = (bp - q) / b
 * Where:
 *   b = net odds (payout / risk = (1/price - 1))
 *   p = estimated probability of winning
 *   q = 1 - p
 *
 * We use fractional Kelly (25%) because our probability estimates are uncertain.
 */
export function sizePositions(
  signals: Signal[],
  balance: number,
  openPositions: OpenPosition[]
): SizedPosition[] {
  const maxPositions = TRADING.maxOpenPositions - openPositions.length;
  if (maxPositions <= 0) {
    log.info("Max open positions reached, skipping sizing");
    return [];
  }

  // Limit to max trades per cycle
  const toSize = signals.slice(0, Math.min(TRADING.maxTradesPerCycle, maxPositions));
  const positions: SizedPosition[] = [];

  for (const signal of toSize) {
    const sized = sizeOne(signal, balance);
    if (sized) {
      positions.push(sized);
      // Reduce available balance for next position
      balance -= sized.positionSize;
    }
  }

  return positions;
}

function sizeOne(signal: Signal, balance: number): SizedPosition | null {
  const price = signal.marketPrice;

  // Skip longshot markets below threshold (e.g., < 10 cents) - these rarely win
  if (price < TRADING.minPriceThreshold) {
    log.debug(`Skipping longshot "${signal.market.question}" (price ${price} < ${TRADING.minPriceThreshold})`);
    return null;
  }

  // Net odds: if we buy at 0.40, we get back $1 if we win, so b = (1/0.40 - 1) = 1.5
  const b = 1 / price - 1;

  // p = our estimated probability of this outcome
  // For YES side: p = fairYes. For NO side: p = 1 - fairYes
  const p = signal.side === "YES" ? signal.fairYes : 1 - signal.fairYes;
  const q = 1 - p;

  // Full Kelly fraction
  const fullKelly = (b * p - q) / b;

  if (fullKelly <= 0) {
    log.debug(`Negative Kelly for "${signal.market.question}", skipping`);
    return null;
  }

  // Fractional Kelly
  const kellyFraction = fullKelly * TRADING.kellyFraction;

  // Position size in USD
  let positionSize = balance * kellyFraction;

  // Asymmetric max position sizing based on entry price
  // Cheap bets (< 0.35): up to 15% — high payoff ratio justifies larger position
  // Mid bets (0.35-0.50): up to 12% — moderate payoff
  // Expensive bets (> 0.50): capped at 8% — low payoff, high risk zone
  let maxPositionPct: number;
  if (price < 0.35) {
    maxPositionPct = 0.15;
  } else if (price <= 0.50) {
    maxPositionPct = 0.12;
  } else {
    maxPositionPct = 0.08;
  }
  const maxSize = balance * maxPositionPct;
  positionSize = Math.min(positionSize, maxSize);

  // Max loss cap: no single trade can risk more than $75 or 7.5% of bankroll
  // When you buy at price X, your max loss IS the position size (you lose everything if wrong)
  const maxRiskDollars = Math.min(75, balance * TRADING.maxTradeRisk);
  positionSize = Math.min(positionSize, maxRiskDollars);

  // Floor at minimum trade size
  if (positionSize < TRADING.minTradeSize) {
    log.debug(
      `Position too small ($${positionSize.toFixed(2)}) for "${signal.market.question}"`
    );
    return null;
  }

  // Round to 2 decimal places (USDC precision)
  positionSize = Math.floor(positionSize * 100) / 100;

  const shares = positionSize / price;

  log.info(`Sized: $${positionSize.toFixed(2)} on ${signal.side} "${signal.market.question}"`, {
    kelly: (kellyFraction * 100).toFixed(1) + "%",
    maxPct: (maxPositionPct * 100).toFixed(0) + "%",
    maxRisk: "$" + maxRiskDollars.toFixed(0),
    shares: shares.toFixed(2),
    price: price.toFixed(3),
  });

  return {
    signal,
    kellyFraction,
    positionSize,
    shares,
  };
}
