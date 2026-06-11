import type { Address } from 'viem';
import { zeroAddress } from 'viem';
import { baseSepolia, sepolia } from 'wagmi/chains';
import capstoneDeployment from '@/generated/sepolia.json';
import productionDeployment from '@/generated/base-sepolia-production.json';

export type DemoMode = 'capstone' | 'production';

export type Deployment = {
  network: string;
  chainId: number;
  isDeployed: boolean;
  poolManager: Address;
  poolSwapTest: Address;
  poolModifyLiquidityTest?: Address;
  liquidityRouter?: Address;
  hook: Address;
  hedgeAdapter?: Address;
  collateralToken?: Address;
  baseToken: Address;
  quoteToken: Address;
  currency0: Address;
  currency1: Address;
  hooks: Address;
  fee: number;
  tickSpacing: number;
  poolId: `0x${string}`;
  baseIsCurrency0: boolean;
  hedgeThresholdBase?: string;
  maxResidualDeltaBase?: string;
  minCollateralUsd?: string;
  maxSnapshotAge?: number;
  minCollateralRatioBps?: number;
  maxLeverageBps?: number;
  maxLossBps?: number;
};

export type ModeConfig = {
  mode: DemoMode;
  label: string;
  chainId: number;
  chainName: string;
  deployment: Deployment;
};

export const modeConfigs: Record<DemoMode, ModeConfig> = {
  capstone: {
    mode: 'capstone',
    label: 'Capstone / Sepolia',
    chainId: sepolia.id,
    chainName: sepolia.name,
    deployment: capstoneDeployment as Deployment,
  },
  production: {
    mode: 'production',
    label: 'Production / Base Sepolia',
    chainId: baseSepolia.id,
    chainName: baseSepolia.name,
    deployment: productionDeployment as Deployment,
  },
};

export function deploymentReady(deployment: Deployment) {
  return (
    deployment.isDeployed &&
    deployment.hook !== zeroAddress &&
    deployment.baseToken !== zeroAddress &&
    deployment.quoteToken !== zeroAddress
  );
}

export function poolKeyFor(deployment: Deployment) {
  return {
    currency0: deployment.currency0,
    currency1: deployment.currency1,
    fee: deployment.fee,
    tickSpacing: deployment.tickSpacing,
    hooks: deployment.hooks,
  } as const;
}
