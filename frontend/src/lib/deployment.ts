import type { Address } from 'viem';
import { zeroAddress } from 'viem';
import rawDeployment from '@/generated/sepolia.json';

export type Deployment = typeof rawDeployment & {
  poolManager: Address;
  poolSwapTest: Address;
  poolModifyLiquidityTest: Address;
  hook: Address;
  baseToken: Address;
  quoteToken: Address;
  currency0: Address;
  currency1: Address;
  hooks: Address;
};

export const deployment = rawDeployment as Deployment;

export const isDeploymentReady =
  deployment.isDeployed &&
  deployment.hook !== zeroAddress &&
  deployment.baseToken !== zeroAddress &&
  deployment.quoteToken !== zeroAddress;

export const poolKey = {
  currency0: deployment.currency0,
  currency1: deployment.currency1,
  fee: deployment.fee,
  tickSpacing: deployment.tickSpacing,
  hooks: deployment.hooks,
} as const;

