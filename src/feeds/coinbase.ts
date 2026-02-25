import WebSocket from "ws";
import { createLogger } from "../logger";
import { COINBASE_WS_URL, COINBASE_PRODUCT_IDS, TRADING, TrackedSymbol } from "../config";
import { CoinbasePrice, PriceTick } from "../types";

const log = createLogger("coinbase-feed");

// Map Coinbase product_id -> downstream symbol
const PRODUCT_TO_SYMBOL: Record<string, TrackedSymbol> = {
  "BTC-USD": "btcusdt",
  "ETH-USD": "ethusdt",
  "SOL-USD": "solusdt",
};

// Rolling price windows per symbol
const priceWindows: Map<string, PriceTick[]> = new Map();
const latestPrices: Map<string, CoinbasePrice> = new Map();
const moveCallbacks: Array<(symbol: string, price: CoinbasePrice) => void> = [];

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function trimWindow(symbol: string): void {
  const window = priceWindows.get(symbol);
  if (!window) return;
  const cutoff = Date.now() - TRADING.priceWindowSeconds * 1000;
  while (window.length > 0 && window[0].timestamp < cutoff) {
    window.shift();
  }
}

function computeChange(symbol: string, seconds: number): number {
  const window = priceWindows.get(symbol);
  if (!window || window.length < 2) return 0;
  const cutoff = Date.now() - seconds * 1000;
  let earliest: PriceTick | null = null;
  for (const tick of window) {
    if (tick.timestamp >= cutoff) {
      earliest = tick;
      break;
    }
  }
  if (!earliest) return 0;
  const latest = window[window.length - 1];
  return (latest.price - earliest.price) / earliest.price;
}

/**
 * Compute annualized realized volatility from the rolling price window.
 * Uses log returns sampled at ~1s intervals.
 */
function computeRealizedVol(symbol: string): number {
  const window = priceWindows.get(symbol);
  if (!window || window.length < TRADING.volMinSamples) {
    return TRADING.defaultAnnualVol;
  }

  // Sample at ~5s intervals to reduce microstructure noise
  const sampleInterval = 5000; // 5s
  const samples: number[] = [];
  let lastTs = 0;
  for (const tick of window) {
    if (tick.timestamp - lastTs >= sampleInterval) {
      samples.push(tick.price);
      lastTs = tick.timestamp;
    }
  }

  if (samples.length < 10) return TRADING.defaultAnnualVol;

  // Compute log returns
  const logReturns: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    logReturns.push(Math.log(samples[i] / samples[i - 1]));
  }

  // Standard deviation of log returns
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Annualize: each sample is ~5s apart
  // Periods per year = (365.25 * 24 * 3600) / 5
  const periodsPerYear = (365.25 * 24 * 3600) / 5;
  const annualized = stdDev * Math.sqrt(periodsPerYear);

  // Clamp to reasonable range (20% - 300%)
  return Math.max(0.20, Math.min(3.0, annualized));
}

function getMomentumDirection(change1m: number): "up" | "down" | "flat" {
  if (change1m > TRADING.momentumThreshold) return "up";
  if (change1m < -TRADING.momentumThreshold) return "down";
  return "flat";
}

function handleMatch(productId: string, priceStr: string, timeStr: string): void {
  const symbol = PRODUCT_TO_SYMBOL[productId];
  if (!symbol) return;

  const price = parseFloat(priceStr);
  const timestamp = new Date(timeStr).getTime();

  if (!priceWindows.has(symbol)) {
    priceWindows.set(symbol, []);
  }
  priceWindows.get(symbol)!.push({ price, timestamp });
  trimWindow(symbol);

  const change1m = computeChange(symbol, 60);
  const change5m = computeChange(symbol, 300);
  const momentum = getMomentumDirection(change1m);
  const realizedVol = computeRealizedVol(symbol);

  const cp: CoinbasePrice = {
    symbol,
    price,
    timestamp,
    change1m,
    change5m,
    momentum,
    realizedVol,
  };
  latestPrices.set(symbol, cp);

  // Fire callbacks on significant moves (0.01%+ in 30s)
  const change30s = computeChange(symbol, 30);
  if (Math.abs(change30s) >= TRADING.momentumThreshold) {
    for (const cb of moveCallbacks) {
      try {
        cb(symbol, cp);
      } catch (e) {
        log.error("Price move callback error", e);
      }
    }
  }
}

function connect(): void {
  log.info("Connecting to Coinbase WebSocket", { url: COINBASE_WS_URL });
  ws = new WebSocket(COINBASE_WS_URL);

  ws.on("open", () => {
    log.info("Coinbase WebSocket connected");
    const subscribeMsg = JSON.stringify({
      type: "subscribe",
      product_ids: COINBASE_PRODUCT_IDS,
      channels: ["matches"],
    });
    ws!.send(subscribeMsg);
    log.info("Subscribed to Coinbase matches", { products: COINBASE_PRODUCT_IDS });
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "match" || msg.type === "last_match") {
        handleMatch(msg.product_id, msg.price, msg.time);
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on("close", () => {
    log.warn("Coinbase WebSocket disconnected");
    scheduleReconnect();
  });

  ws.on("error", (err: Error) => {
    log.error("Coinbase WebSocket error", err.message);
    ws?.close();
  });
}

function scheduleReconnect(): void {
  if (!running) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    log.info("Reconnecting to Coinbase...");
    connect();
  }, 3000);
}

// ── Public API ──

export function startFeed(): void {
  running = true;
  connect();
}

export function stopFeed(): void {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}

export function getPrice(symbol: string): CoinbasePrice | null {
  return latestPrices.get(symbol.toLowerCase()) || null;
}

export function onPriceMove(callback: (symbol: string, price: CoinbasePrice) => void): void {
  moveCallbacks.push(callback);
}

export function hasPriceData(): boolean {
  return latestPrices.size > 0;
}

export function getAllPrices(): Map<string, CoinbasePrice> {
  return new Map(latestPrices);
}
