import WebSocket from "ws";
import { createLogger } from "../logger";
import { BINANCE_WS_URL, TRACKED_SYMBOLS, TrackedSymbol, UPDOWN_TRADING } from "./config";
import { BinancePrice, PriceTick } from "./types";

const log = createLogger("binance-feed");

// Rolling price windows per symbol
const priceWindows: Map<string, PriceTick[]> = new Map();
const latestPrices: Map<string, BinancePrice> = new Map();
const moveCallbacks: Array<(symbol: string, price: BinancePrice) => void> = [];

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function trimWindow(symbol: string): void {
  const window = priceWindows.get(symbol);
  if (!window) return;
  const cutoff = Date.now() - UPDOWN_TRADING.priceWindowSeconds * 1000;
  while (window.length > 0 && window[0].timestamp < cutoff) {
    window.shift();
  }
}

function computeChange(symbol: string, seconds: number): number {
  const window = priceWindows.get(symbol);
  if (!window || window.length < 2) return 0;
  const now = Date.now();
  const cutoff = now - seconds * 1000;
  // Find the earliest tick within the lookback period
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

function getMomentumDirection(change1m: number): "up" | "down" | "flat" {
  if (change1m > UPDOWN_TRADING.momentumThreshold) return "up";
  if (change1m < -UPDOWN_TRADING.momentumThreshold) return "down";
  return "flat";
}

function handleTrade(data: { s: string; p: string; T: number }): void {
  const symbol = data.s.toLowerCase() as TrackedSymbol;
  const price = parseFloat(data.p);
  const timestamp = data.T;

  if (!priceWindows.has(symbol)) {
    priceWindows.set(symbol, []);
  }
  priceWindows.get(symbol)!.push({ price, timestamp });
  trimWindow(symbol);

  const change1m = computeChange(symbol, 60);
  const change5m = computeChange(symbol, 300);
  const momentum = getMomentumDirection(change1m);

  const bp: BinancePrice = {
    symbol,
    price,
    timestamp,
    change1m,
    change5m,
    momentum,
  };
  latestPrices.set(symbol, bp);

  // Check for significant move (0.1% in 30s)
  const change30s = computeChange(symbol, 30);
  if (Math.abs(change30s) >= UPDOWN_TRADING.momentumThreshold) {
    for (const cb of moveCallbacks) {
      try {
        cb(symbol, bp);
      } catch (e) {
        log.error("Price move callback error", e);
      }
    }
  }
}

function connect(): void {
  const streams = TRACKED_SYMBOLS.map((s) => `${s}@trade`).join("/");
  const url = `${BINANCE_WS_URL}/${streams}`;

  log.info("Connecting to Binance WebSocket", { url });
  ws = new WebSocket(url);

  ws.on("open", () => {
    log.info("Binance WebSocket connected");
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Combined stream format: { stream: "btcusdt@trade", data: { ... } }
      if (msg.data && msg.data.e === "trade") {
        handleTrade(msg.data);
      } else if (msg.e === "trade") {
        // Single stream format
        handleTrade(msg);
      }
    } catch (e) {
      // Ignore parse errors for non-trade messages
    }
  });

  ws.on("close", () => {
    log.warn("Binance WebSocket disconnected");
    scheduleReconnect();
  });

  ws.on("error", (err: Error) => {
    log.error("Binance WebSocket error", err.message);
    ws?.close();
  });
}

function scheduleReconnect(): void {
  if (!running) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    log.info("Reconnecting to Binance...");
    connect();
  }, 3000);
}

// ─── Public API ───

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

export function getPrice(symbol: string): BinancePrice | null {
  return latestPrices.get(symbol.toLowerCase()) || null;
}

export function getMomentum(symbol: string): BinancePrice | null {
  return latestPrices.get(symbol.toLowerCase()) || null;
}

export function onPriceMove(callback: (symbol: string, price: BinancePrice) => void): void {
  moveCallbacks.push(callback);
}

export function hasPriceData(): boolean {
  return latestPrices.size > 0;
}

export function getAllPrices(): Map<string, BinancePrice> {
  return new Map(latestPrices);
}
