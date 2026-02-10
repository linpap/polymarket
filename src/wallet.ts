import { ethers, Contract, Wallet } from "ethers";
import {
  PRIVATE_KEY,
  POLYGON_RPC,
  USDC_ADDRESS,
  CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE,
  CONDITIONAL_TOKENS,
} from "./config";
import { createLogger } from "./logger";

const log = createLogger("wallet");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

const ERC1155_ABI = [
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
];

let provider: ethers.providers.JsonRpcProvider;
let wallet: Wallet;

export function getProvider(): ethers.providers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
  }
  return provider;
}

export function getWallet(): Wallet {
  if (!wallet) {
    wallet = new Wallet(PRIVATE_KEY, getProvider());
  }
  return wallet;
}

export async function getUsdcBalance(): Promise<number> {
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, getProvider());
  const balance = await usdc.balanceOf(getWallet().address);
  // USDC.e has 6 decimals
  return parseFloat(ethers.utils.formatUnits(balance, 6));
}

export async function getPolBalance(): Promise<number> {
  const balance = await getProvider().getBalance(getWallet().address);
  return parseFloat(ethers.utils.formatEther(balance));
}

export async function checkAllowances(): Promise<{
  usdcToCTF: boolean;
  ctfToExchange: boolean;
  ctfToNegRisk: boolean;
}> {
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, getProvider());
  const ctf = new Contract(CONDITIONAL_TOKENS, ERC1155_ABI, getProvider());
  const addr = getWallet().address;

  const [usdcAllowance, ctfApproved, negRiskApproved] = await Promise.all([
    usdc.allowance(addr, CTF_EXCHANGE),
    ctf.isApprovedForAll(addr, CTF_EXCHANGE),
    ctf.isApprovedForAll(addr, NEG_RISK_CTF_EXCHANGE),
  ]);

  return {
    usdcToCTF: usdcAllowance.gt(0),
    ctfToExchange: ctfApproved,
    ctfToNegRisk: negRiskApproved,
  };
}

export async function approveAll(): Promise<void> {
  const signer = getWallet();
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, signer);
  const ctf = new Contract(CONDITIONAL_TOKENS, ERC1155_ABI, signer);

  log.info("Approving USDC.e for CTF Exchange...");
  const tx1 = await usdc.approve(CTF_EXCHANGE, ethers.constants.MaxUint256);
  await tx1.wait();
  log.info("USDC.e approved for CTF Exchange", { tx: tx1.hash });

  log.info("Approving CTF tokens for CTF Exchange...");
  const tx2 = await ctf.setApprovalForAll(CTF_EXCHANGE, true);
  await tx2.wait();
  log.info("CTF tokens approved for CTF Exchange", { tx: tx2.hash });

  log.info("Approving CTF tokens for Neg Risk CTF Exchange...");
  const tx3 = await ctf.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true);
  await tx3.wait();
  log.info("CTF tokens approved for Neg Risk CTF Exchange", { tx: tx3.hash });
}
