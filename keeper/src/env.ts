import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { Hex } from 'viem';
import type { HookMode } from './deployment.js';

const keeperDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(keeperDir, '../..');
const keeperRoot = resolve(keeperDir, '..');

for (const path of [resolve(projectRoot, '.env'), resolve(keeperRoot, '.env')]) {
  if (existsSync(path)) {
    loadDotenv({ path, override: path.startsWith(keeperRoot) });
  }
}

export type KeeperConfig = {
  mode: HookMode;
  rpcUrl: string;
  privateKey: Hex;
  pollIntervalMs: number;
  dryRun: boolean;
  maxHedgeSlippageBps: bigint;
};

export function loadKeeperConfig(): KeeperConfig {
  const mode = parseHookMode(process.env.HOOK_MODE);
  const keeperPrivateKey = process.env.KEEPER_PRIVATE_KEY?.trim();
  const privateKey = keeperPrivateKey ? keeperPrivateKey : process.env.PRIVATE_KEY;
  const rpcUrl = mode === 'production' ? process.env.BASE_SEPOLIA_RPC_URL : process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    throw new Error(`Missing ${mode === 'production' ? 'BASE_SEPOLIA_RPC_URL' : 'SEPOLIA_RPC_URL'} in environment.`);
  }
  if (!privateKey) {
    throw new Error('Missing KEEPER_PRIVATE_KEY or PRIVATE_KEY in environment.');
  }

  return {
    mode,
    rpcUrl,
    privateKey: normalizePrivateKey(privateKey),
    pollIntervalMs: parsePositiveInteger(process.env.POLL_INTERVAL_MS, 12_000),
    dryRun: parseBoolean(process.env.DRY_RUN),
    maxHedgeSlippageBps: BigInt(parsePositiveInteger(process.env.MAX_HEDGE_SLIPPAGE_BPS, 100)),
  };
}

function parseHookMode(value: string | undefined): HookMode {
  if (!value) return 'capstone';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'capstone' || normalized === 'production') return normalized;
  throw new Error('HOOK_MODE must be capstone or production.');
}

function normalizePrivateKey(value: string): Hex {
  const trimmed = value.trim();
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new Error('Keeper private key must be a 32-byte hex string.');
  }
  return prefixed as Hex;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('POLL_INTERVAL_MS must be a positive integer.');
  }
  return parsed;
}

function parseBoolean(value: string | undefined) {
  return value === '1' || value?.toLowerCase() === 'true';
}
