import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { getAddress, isAddress, parseEther, parseUnits, type Address, type Hex } from 'viem';
import { clampTraderCount, parseFundingTarget, txIntervalFromRateLimit } from '../shared/math.js';

const serverDir = dirname(fileURLToPath(import.meta.url));
export const liveDemoRoot = resolve(serverDir, '../..');
export const projectRoot = resolve(liveDemoRoot, '..');
const defaultDeploymentPath = resolve(projectRoot, 'deployments/base-sepolia-production.json');

for (const path of [resolve(projectRoot, '.env'), resolve(liveDemoRoot, '.env')]) {
  if (existsSync(path)) loadDotenv({ path, override: path.startsWith(liveDemoRoot) });
}

export type Deployment = {
  baseIsCurrency0: boolean;
  baseToken: Address;
  chainId: number;
  collateralToken: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  hedgeAdapter: Address;
  hook: Address;
  hooks: Address;
  liquidityRouter: Address;
  network: string;
  poolId: Hex;
  poolManager: Address;
  poolSwapTest: Address;
  quoteToken: Address;
  tickSpacing: number;
};

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type LiveDemoConfig = {
  apiPort: number;
  rpcUrl: string;
  rpcUrls: string[];
  writeRpcUrl: string;
  privateKey: Hex;
  traderCount: number;
  traderFundingWei: bigint;
  traderFundingEth: string;
  swapIntervalMs: number;
  keeperIntervalMs: number;
  maxTxPerMinute: number;
  maxRuntimeMinutes: number;
  minSwapAmount: bigint;
  maxSwapAmount: bigint;
  maxHedgeSlippageBps: bigint;
  deploymentPath: string;
  stateDir: string;
  minTxIntervalMs: number;
  getLogsBlockSpan: number;
  priceBackfillBlocks: number;
  replacementFeeBumpBps: bigint;
  nonceConfirmTimeoutMs: number;
  allowWalletRotation: boolean;
};

export function loadLiveConfig(): LiveDemoConfig {
  const traderFundingEth = process.env.LIVE_TRADER_FUNDING_ETH?.trim() || '0.05';
  const maxTxPerMinute = parsePositiveInt(process.env.LIVE_MAX_TX_PER_MIN, 30);
  const rpcUrls = parseRpcUrls();
  return {
    apiPort: parsePositiveInt(process.env.LIVE_DEMO_API_PORT, 8787),
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL?.trim() || rpcUrls[0],
    rpcUrls,
    writeRpcUrl: process.env.BASE_SEPOLIA_WRITE_RPC_URL?.trim() || process.env.BASE_SEPOLIA_RPC_URL?.trim() || rpcUrls[0],
    privateKey: normalizePrivateKey(required(process.env.PRIVATE_KEY, 'PRIVATE_KEY')),
    traderCount: clampTraderCount(parsePositiveInt(process.env.LIVE_TRADER_COUNT, 10)),
    traderFundingWei: parseFundingTarget(traderFundingEth),
    traderFundingEth,
    swapIntervalMs: parsePositiveInt(process.env.LIVE_SWAP_INTERVAL_MS, 4000),
    keeperIntervalMs: parsePositiveInt(process.env.LIVE_KEEPER_INTERVAL_MS, 8000),
    maxTxPerMinute,
    maxRuntimeMinutes: parsePositiveInt(process.env.LIVE_MAX_RUNTIME_MINUTES, 20),
    minSwapAmount: parseUnits(process.env.LIVE_SWAP_MIN_BASE || '0.02', 18),
    maxSwapAmount: parseUnits(process.env.LIVE_SWAP_MAX_BASE || '0.35', 18),
    maxHedgeSlippageBps: BigInt(parsePositiveInt(process.env.MAX_HEDGE_SLIPPAGE_BPS, 100)),
    deploymentPath: process.env.LIVE_DEPLOYMENT_PATH || defaultDeploymentPath,
    stateDir: resolve(liveDemoRoot, '.demo-state'),
    minTxIntervalMs: txIntervalFromRateLimit(maxTxPerMinute),
    getLogsBlockSpan: parsePositiveInt(process.env.LIVE_GET_LOGS_BLOCK_SPAN, 10),
    priceBackfillBlocks: parsePositiveInt(process.env.LIVE_PRICE_BACKFILL_BLOCKS, 40),
    replacementFeeBumpBps: BigInt(parsePositiveInt(process.env.LIVE_REPLACEMENT_FEE_BUMP_BPS, 2500)),
    nonceConfirmTimeoutMs: parsePositiveInt(process.env.LIVE_NONCE_CONFIRM_TIMEOUT_MS, 120_000),
    allowWalletRotation: parseBoolean(process.env.LIVE_ALLOW_WALLET_ROTATION),
  };
}

export function loadDeployment(path: string): Deployment {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const requiredAddress = (key: string) => {
    const value = raw[key];
    if (typeof value !== 'string' || !isAddress(value)) throw new Error(`Deployment is missing address ${key}.`);
    return getAddress(value);
  };
  const poolId = raw.poolId;
  if (typeof poolId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new Error('Deployment is missing poolId.');
  return {
    baseIsCurrency0: Boolean(raw.baseIsCurrency0),
    baseToken: requiredAddress('baseToken'),
    chainId: Number(raw.chainId),
    collateralToken: requiredAddress('collateralToken'),
    currency0: requiredAddress('currency0'),
    currency1: requiredAddress('currency1'),
    fee: Number(raw.fee),
    hedgeAdapter: requiredAddress('hedgeAdapter'),
    hook: requiredAddress('hook'),
    hooks: requiredAddress('hooks'),
    liquidityRouter: requiredAddress('liquidityRouter'),
    network: String(raw.network || 'base-sepolia'),
    poolId: poolId as Hex,
    poolManager: requiredAddress('poolManager'),
    poolSwapTest: requiredAddress('poolSwapTest'),
    quoteToken: requiredAddress('quoteToken'),
    tickSpacing: Number(raw.tickSpacing),
  };
}

export function poolKeyFromDeployment(deployment: Deployment): PoolKey {
  return {
    currency0: deployment.currency0,
    currency1: deployment.currency1,
    fee: deployment.fee,
    tickSpacing: deployment.tickSpacing,
    hooks: deployment.hooks,
  };
}

export function configView(config: LiveDemoConfig, deployment: Deployment) {
  return {
    chainId: deployment.chainId,
    network: deployment.network,
    hook: deployment.hook,
    hedgeAdapter: deployment.hedgeAdapter,
    poolId: deployment.poolId,
    traderCount: config.traderCount,
    traderFundingEth: config.traderFundingEth,
    swapIntervalMs: config.swapIntervalMs,
    keeperIntervalMs: config.keeperIntervalMs,
    maxTxPerMinute: config.maxTxPerMinute,
    maxRuntimeMinutes: config.maxRuntimeMinutes,
  };
}

function required(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`Missing ${name} in environment.`);
  return value.trim();
}

function normalizePrivateKey(value: string): Hex {
  const prefixed = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) throw new Error('PRIVATE_KEY must be a 32-byte hex string.');
  return prefixed as Hex;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Expected a positive integer environment value.');
  return parsed;
}

function parseRpcUrls() {
  const defaults = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
  const configured = process.env.BASE_SEPOLIA_RPC_URLS?.split(',').map((url) => url.trim()).filter(Boolean) ?? [];
  const primary = process.env.BASE_SEPOLIA_RPC_URL?.trim();
  return uniqueStrings([...(primary ? [primary] : []), ...configured, ...defaults]);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function parseBoolean(value: string | undefined) {
  return value === '1' || value?.toLowerCase() === 'true';
}
