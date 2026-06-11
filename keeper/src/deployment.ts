import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';

const keeperDir = dirname(fileURLToPath(import.meta.url));
const defaultDeploymentPath = resolve(keeperDir, '../../deployments/sepolia.json');

export type Deployment = {
  chainId: number;
  network: string;
  hook: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  baseToken: Address;
  quoteToken: Address;
  poolId: `0x${string}`;
};

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export function loadDeployment(path = process.env.DEPLOYMENT_PATH ?? defaultDeploymentPath): Deployment {
  return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
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
