import { formatUnits } from 'viem';

export type RiskState = {
  poolBaseExposure: bigint;
  reportedHedgeBase: bigint;
  pendingHedgeBase: bigint;
  lastReferencePriceX96: bigint;
  lastReferenceTimestamp: bigint;
  hedgeNonce: bigint;
  paused: boolean;
};

export type KeeperDecision =
  | {
      kind: 'skip';
      reason: 'not-keeper' | 'no-pending-hedge' | 'stale-state';
      message: string;
    }
  | {
      kind: 'dry-run' | 'record';
      nonce: bigint;
      hedgeBaseDelta: bigint;
      message: string;
    };

export type ProductionRiskState = {
  poolBaseExposure: bigint;
  hedgePositionBase: bigint;
  targetHedgeBase: bigint;
  pendingOrderBase: bigint;
  netBaseDelta: bigint;
  realizedPnlUsd: bigint;
  unrealizedPnlUsd: bigint;
  collateralUsd: bigint;
  initialCollateralUsd: bigint;
  lastMarkPrice: bigint;
  lastSnapshotTimestamp: bigint;
  pendingOrderReadyAt: bigint;
  lastRebalanceTimestamp: bigint;
  lpBaseDeposited: bigint;
  lpBaseWithdrawn: bigint;
  lpBaseFeesAccrued: bigint;
  pendingOrderId: `0x${string}`;
  adapterHealthy: boolean;
  healthMode: number;
};

export type ProductionPoolConfig = {
  hedgeThresholdBase: bigint;
};

export type ProductionKeeperDecision =
  | {
      kind: 'skip';
      reason: 'not-keeper' | 'pending-not-ready' | 'inside-threshold' | 'missing-price';
      message: string;
    }
  | {
      kind: 'sync';
      message: string;
    }
  | {
      kind: 'settle';
      orderId: `0x${string}`;
      message: string;
    }
  | {
      kind: 'rebalance';
      hedgeBaseDelta: bigint;
      acceptablePrice: bigint;
      message: string;
    };

export function decideHedgeFill(input: {
  keeperAllowed: boolean;
  dryRun: boolean;
  observed: RiskState;
  latest: RiskState;
}): KeeperDecision {
  if (!input.keeperAllowed) {
    return {
      kind: 'skip',
      reason: 'not-keeper',
      message: 'Connected keeper address is not authorized on the hook.',
    };
  }

  if (input.observed.pendingHedgeBase === 0n) {
    return {
      kind: 'skip',
      reason: 'no-pending-hedge',
      message: 'No pending hedge. Delta is inside the hook threshold or already neutralized.',
    };
  }

  if (
    input.observed.hedgeNonce !== input.latest.hedgeNonce ||
    input.observed.pendingHedgeBase !== input.latest.pendingHedgeBase
  ) {
    return {
      kind: 'skip',
      reason: 'stale-state',
      message: 'Pending hedge changed before submission. Skipping this tick and using fresh state next tick.',
    };
  }

  const action = input.dryRun ? 'dry-run' : 'record';
  return {
    kind: action,
    nonce: input.latest.hedgeNonce,
    hedgeBaseDelta: input.latest.pendingHedgeBase,
    message:
      action === 'dry-run'
        ? 'Dry run: keeper would record the pending hedge fill.'
        : 'Keeper will record the pending hedge fill.',
  };
}

export function normalizeRiskState(data: unknown): RiskState {
  const value = data as Partial<RiskState> & Record<number, unknown>;
  return {
    poolBaseExposure: coerceBigInt(value.poolBaseExposure ?? value[0]),
    reportedHedgeBase: coerceBigInt(value.reportedHedgeBase ?? value[1]),
    pendingHedgeBase: coerceBigInt(value.pendingHedgeBase ?? value[2]),
    lastReferencePriceX96: coerceBigInt(value.lastReferencePriceX96 ?? value[3]),
    lastReferenceTimestamp: coerceBigInt(value.lastReferenceTimestamp ?? value[4]),
    hedgeNonce: coerceBigInt(value.hedgeNonce ?? value[5]),
    paused: Boolean(value.paused ?? value[6] ?? false),
  };
}

export function decideProductionAction(input: {
  keeperAllowed: boolean;
  state: ProductionRiskState;
  config: ProductionPoolConfig;
  now: bigint;
  maxHedgeSlippageBps: bigint;
}): ProductionKeeperDecision {
  if (!input.keeperAllowed) {
    return {
      kind: 'skip',
      reason: 'not-keeper',
      message: 'Connected keeper address is not authorized on the production hook.',
    };
  }

  if (input.state.pendingOrderId !== zeroHash || input.state.pendingOrderBase !== 0n) {
    if (input.state.pendingOrderReadyAt !== 0n && input.now >= input.state.pendingOrderReadyAt) {
      return {
        kind: 'settle',
        orderId: input.state.pendingOrderId,
        message: `Pending hedge order ${input.state.pendingOrderId} is ready to settle.`,
      };
    }
    return {
      kind: 'skip',
      reason: 'pending-not-ready',
      message: 'Production hedge order is pending and not ready for settlement.',
    };
  }

  const netDelta = input.state.netBaseDelta;
  if (absBigInt(netDelta) < input.config.hedgeThresholdBase) {
    return {
      kind: 'skip',
      reason: 'inside-threshold',
      message: 'Production net delta is inside the hedge threshold.',
    };
  }

  if (input.state.lastMarkPrice === 0n) {
    return {
      kind: 'skip',
      reason: 'missing-price',
      message: 'Production hook has no mark price, so acceptable hedge price cannot be computed.',
    };
  }

  const hedgeBaseDelta = -netDelta;
  return {
    kind: 'rebalance',
    hedgeBaseDelta,
    acceptablePrice: computeAcceptablePrice(input.state.lastMarkPrice, hedgeBaseDelta, input.maxHedgeSlippageBps),
    message: 'Production keeper will commit a hedge rebalance.',
  };
}

export function computeAcceptablePrice(markPrice: bigint, hedgeBaseDelta: bigint, slippageBps: bigint) {
  if (hedgeBaseDelta > 0n) {
    return (markPrice * (10_000n + slippageBps)) / 10_000n;
  }
  return (markPrice * (10_000n - slippageBps)) / 10_000n;
}

export function normalizeProductionRiskState(data: unknown): ProductionRiskState {
  const value = data as Partial<ProductionRiskState> & Record<number, unknown>;
  return {
    poolBaseExposure: coerceBigInt(value.poolBaseExposure ?? value[0]),
    hedgePositionBase: coerceBigInt(value.hedgePositionBase ?? value[1]),
    targetHedgeBase: coerceBigInt(value.targetHedgeBase ?? value[2]),
    pendingOrderBase: coerceBigInt(value.pendingOrderBase ?? value[3]),
    netBaseDelta: coerceBigInt(value.netBaseDelta ?? value[4]),
    realizedPnlUsd: coerceBigInt(value.realizedPnlUsd ?? value[5]),
    unrealizedPnlUsd: coerceBigInt(value.unrealizedPnlUsd ?? value[6]),
    collateralUsd: coerceBigInt(value.collateralUsd ?? value[7]),
    initialCollateralUsd: coerceBigInt(value.initialCollateralUsd ?? value[8]),
    lastMarkPrice: coerceBigInt(value.lastMarkPrice ?? value[9]),
    lastSnapshotTimestamp: coerceBigInt(value.lastSnapshotTimestamp ?? value[10]),
    pendingOrderReadyAt: coerceBigInt(value.pendingOrderReadyAt ?? value[11]),
    lastRebalanceTimestamp: coerceBigInt(value.lastRebalanceTimestamp ?? value[12]),
    lpBaseDeposited: coerceBigInt(value.lpBaseDeposited ?? value[13]),
    lpBaseWithdrawn: coerceBigInt(value.lpBaseWithdrawn ?? value[14]),
    lpBaseFeesAccrued: coerceBigInt(value.lpBaseFeesAccrued ?? value[15]),
    pendingOrderId: normalizeHash(value.pendingOrderId ?? value[16]),
    adapterHealthy: Boolean(value.adapterHealthy ?? value[17] ?? false),
    healthMode: Number(value.healthMode ?? value[18] ?? 0),
  };
}

export function normalizeProductionPoolConfig(data: unknown): ProductionPoolConfig {
  const value = data as Partial<ProductionPoolConfig> & Record<number, unknown>;
  return {
    hedgeThresholdBase: coerceBigInt(value.hedgeThresholdBase ?? value[7]),
  };
}

export function formatDeltaEquation(state: RiskState, netDelta: bigint) {
  return `${formatSignedBase(state.poolBaseExposure)} pool + ${formatSignedBase(
    state.reportedHedgeBase,
  )} hedge = ${formatSignedBase(netDelta)} net`;
}

export function formatSignedBase(value: bigint) {
  const sign = value < 0n ? '-' : value > 0n ? '+' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${trimDecimals(formatUnits(abs, 18))}`;
}

function trimDecimals(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.slice(0, 6).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function coerceBigInt(value: unknown) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return BigInt(value);
  }
  return 0n;
}

function absBigInt(value: bigint) {
  return value < 0n ? -value : value;
}

const zeroHash = `0x${'0'.repeat(64)}` as const;

function normalizeHash(value: unknown): `0x${string}` {
  if (typeof value === 'string' && value.startsWith('0x')) return value as `0x${string}`;
  return zeroHash;
}
