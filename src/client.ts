import { ClobClient } from "@polymarket/clob-client";
import fs from "fs";
import {
  CLOB_API,
  CHAIN_ID,
  POLY_API_KEY,
  POLY_API_SECRET,
  POLY_API_PASSPHRASE,
  CREDS_FILE,
  STATE_DIR,
} from "./config";
import { getWallet } from "./wallet";
import { ApiCredentials } from "./types";
import { createLogger } from "./logger";

const log = createLogger("client");

let clobClient: ClobClient | null = null;

function loadCachedCreds(): ApiCredentials | null {
  if (POLY_API_KEY && POLY_API_SECRET && POLY_API_PASSPHRASE) {
    return {
      key: POLY_API_KEY,
      secret: POLY_API_SECRET,
      passphrase: POLY_API_PASSPHRASE,
    };
  }
  try {
    if (fs.existsSync(CREDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
      return data as ApiCredentials;
    }
  } catch {
    log.warn("Failed to load cached API credentials");
  }
  return null;
}

function saveCreds(creds: ApiCredentials): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
  log.info("API credentials cached to disk");
}

export async function getClobClient(): Promise<ClobClient> {
  if (clobClient) return clobClient;

  const wallet = getWallet();
  const cached = loadCachedCreds();

  if (cached) {
    log.info("Using cached API credentials");
    clobClient = new ClobClient(
      CLOB_API,
      CHAIN_ID,
      wallet,
      { key: cached.key, secret: cached.secret, passphrase: cached.passphrase },
      0 // SignatureType EOA
    );
    return clobClient;
  }

  // Derive or create API key
  log.info("Deriving API credentials from wallet...");
  const tempClient = new ClobClient(CLOB_API, CHAIN_ID, wallet);
  const apiCreds = await tempClient.createOrDeriveApiKey();

  const creds: ApiCredentials = {
    key: apiCreds.key,
    secret: apiCreds.secret,
    passphrase: apiCreds.passphrase,
  };
  saveCreds(creds);

  clobClient = new ClobClient(
    CLOB_API,
    CHAIN_ID,
    wallet,
    { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
    0 // SignatureType EOA
  );

  log.info("CLOB client initialized with fresh credentials");
  return clobClient;
}
