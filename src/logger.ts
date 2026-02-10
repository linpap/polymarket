import { LOG_LEVEL } from "./config";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel = LEVELS[LOG_LEVEL as Level] ?? LEVELS.info;

function ts(): string {
  return new Date().toISOString();
}

function fmt(level: Level, module: string, msg: string, data?: unknown): string {
  const base = `[${ts()}] [${level.toUpperCase()}] [${module}] ${msg}`;
  return data !== undefined ? `${base} ${JSON.stringify(data)}` : base;
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: unknown) => {
      if (currentLevel <= LEVELS.debug) console.log(fmt("debug", module, msg, data));
    },
    info: (msg: string, data?: unknown) => {
      if (currentLevel <= LEVELS.info) console.log(fmt("info", module, msg, data));
    },
    warn: (msg: string, data?: unknown) => {
      if (currentLevel <= LEVELS.warn) console.warn(fmt("warn", module, msg, data));
    },
    error: (msg: string, data?: unknown) => {
      if (currentLevel <= LEVELS.error) console.error(fmt("error", module, msg, data));
    },
  };
}
