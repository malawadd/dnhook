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
