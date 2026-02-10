import { Side, OrderType } from "@polymarket/clob-client";
import { getClobClient } from "./client";
import { DRY_RUN } from "./config";
import { SizedPosition, TradeResult } from "./types";
import { createLogger } from "./logger";

const log = createLogger("executor");

export async function executeTrades(
  positions: SizedPosition[]
): Promise<TradeResult[]> {
  const results: TradeResult[] = [];

  for (const pos of positions) {
    const result = await executeSingle(pos);
    results.push(result);

    // Small delay between orders
    if (positions.length > 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return results;
}

async function executeSingle(pos: SizedPosition): Promise<TradeResult> {
  const { signal, positionSize } = pos;
  const timestamp = Date.now();

  if (DRY_RUN) {
    log.info(
      `[DRY RUN] Would ${signal.side} $${positionSize.toFixed(2)} on "${signal.market.question}" @ ${signal.marketPrice.toFixed(3)}`
    );
    return {
      success: true,
      orderId: `dry-run-${timestamp}`,
      signal,
      size: positionSize,
      price: signal.marketPrice,
      side: signal.side,
      timestamp,
    };
  }

  try {
    const client = await getClobClient();

    // Use createAndPostMarketOrder with FOK (Fill or Kill)
    // amount = USD to spend (for BUY side)
    log.info(
      `Placing ${signal.side} market order: $${positionSize.toFixed(2)} on "${signal.market.question}"`
    );

    const result = await client.createAndPostMarketOrder(
      {
        tokenID: signal.tokenId,
        amount: positionSize,
        side: Side.BUY,
      },
      undefined, // let SDK resolve tick size and neg risk
      OrderType.FOK
    );

    const orderId = result?.orderID || result?.id || "unknown";
    log.info(`Order placed successfully`, { orderId, result });

    return {
      success: true,
      orderId,
      signal,
      size: positionSize,
      price: signal.marketPrice,
      side: signal.side,
      timestamp,
    };
  } catch (err: any) {
    log.error(`Order failed for "${signal.market.question}"`, {
      error: err.message || err,
    });

    return {
      success: false,
      signal,
      size: positionSize,
      price: signal.marketPrice,
      side: signal.side,
      timestamp,
      error: err.message || String(err),
    };
  }
}
