import { describe, expect, it } from 'vitest';
import {
  computeAcceptablePrice,
  decideHedgeFill,
  decideProductionAction,
  type ProductionRiskState,
  type RiskState,
} from './risk.js';

const baseState: RiskState = {
  poolBaseExposure: 0n,
  reportedHedgeBase: 0n,
  pendingHedgeBase: 0n,
  lastReferencePriceX96: 1n,
  lastReferenceTimestamp: 1n,
  hedgeNonce: 0n,
  paused: false,
};

describe('decideHedgeFill', () => {
  it('skips when there is no pending hedge', () => {
    const decision = decideHedgeFill({
      keeperAllowed: true,
      dryRun: false,
      observed: baseState,
      latest: baseState,
    });

    expect(decision).toMatchObject({
      kind: 'skip',
      reason: 'no-pending-hedge',
    });
  });

  it('records the exact current nonce and pending hedge amount', () => {
    const state = {
      ...baseState,
      poolBaseExposure: 1_000n,
      pendingHedgeBase: -1_000n,
      hedgeNonce: 7n,
    };

    const decision = decideHedgeFill({
      keeperAllowed: true,
      dryRun: false,
      observed: state,
      latest: state,
    });

    expect(decision).toEqual({
      kind: 'record',
      nonce: 7n,
      hedgeBaseDelta: -1_000n,
      message: 'Keeper will record the pending hedge fill.',
    });
  });

  it('skips stale state when nonce changes before submission', () => {
    const observed = {
      ...baseState,
      pendingHedgeBase: -1_000n,
      hedgeNonce: 7n,
    };
    const latest = {
      ...baseState,
      pendingHedgeBase: -2_000n,
      hedgeNonce: 8n,
    };

    const decision = decideHedgeFill({
      keeperAllowed: true,
      dryRun: false,
      observed,
      latest,
    });

    expect(decision).toMatchObject({
      kind: 'skip',
      reason: 'stale-state',
    });
  });

  it('logs the action without sending in dry-run mode', () => {
    const state = {
      ...baseState,
      poolBaseExposure: -2_500n,
      pendingHedgeBase: 2_500n,
      hedgeNonce: 11n,
    };

    const decision = decideHedgeFill({
      keeperAllowed: true,
      dryRun: true,
      observed: state,
      latest: state,
    });

    expect(decision).toEqual({
      kind: 'dry-run',
      nonce: 11n,
      hedgeBaseDelta: 2_500n,
      message: 'Dry run: keeper would record the pending hedge fill.',
    });
  });
});

const productionBaseState: ProductionRiskState = {
  poolBaseExposure: 0n,
  hedgePositionBase: 0n,
  targetHedgeBase: 0n,
  pendingOrderBase: 0n,
  netBaseDelta: 0n,
  realizedPnlUsd: 0n,
  unrealizedPnlUsd: 0n,
  collateralUsd: 1_000_000n,
  initialCollateralUsd: 1_000_000n,
  lastMarkPrice: 2_000n,
  lastSnapshotTimestamp: 1n,
  pendingOrderReadyAt: 0n,
  lastRebalanceTimestamp: 0n,
  lpBaseDeposited: 0n,
  lpBaseWithdrawn: 0n,
  lpBaseFeesAccrued: 0n,
  pendingOrderId: `0x${'0'.repeat(64)}` as `0x${string}`,
  adapterHealthy: true,
  healthMode: 0,
};

describe('decideProductionAction', () => {
  it('skips when the keeper is not authorized', () => {
    const decision = decideProductionAction({
      keeperAllowed: false,
      state: productionBaseState,
      config: { hedgeThresholdBase: 100n },
      now: 10n,
      maxHedgeSlippageBps: 100n,
    });

    expect(decision).toMatchObject({ kind: 'skip', reason: 'not-keeper' });
  });

  it('settles ready pending production orders first', () => {
    const state = {
      ...productionBaseState,
      pendingOrderId: `0x${'1'.repeat(64)}` as `0x${string}`,
      pendingOrderBase: -1_000n,
      pendingOrderReadyAt: 10n,
    };

    const decision = decideProductionAction({
      keeperAllowed: true,
      state,
      config: { hedgeThresholdBase: 100n },
      now: 10n,
      maxHedgeSlippageBps: 100n,
    });

    expect(decision).toMatchObject({ kind: 'settle', orderId: state.pendingOrderId });
  });

  it('does not overwrite pending production orders before settlement time', () => {
    const decision = decideProductionAction({
      keeperAllowed: true,
      state: {
        ...productionBaseState,
        pendingOrderId: `0x${'2'.repeat(64)}` as `0x${string}`,
        pendingOrderBase: 1_000n,
        pendingOrderReadyAt: 20n,
      },
      config: { hedgeThresholdBase: 100n },
      now: 10n,
      maxHedgeSlippageBps: 100n,
    });

    expect(decision).toMatchObject({ kind: 'skip', reason: 'pending-not-ready' });
  });

  it('rebalances only outside the configured threshold', () => {
    const inside = decideProductionAction({
      keeperAllowed: true,
      state: { ...productionBaseState, netBaseDelta: 99n },
      config: { hedgeThresholdBase: 100n },
      now: 10n,
      maxHedgeSlippageBps: 100n,
    });
    const outside = decideProductionAction({
      keeperAllowed: true,
      state: { ...productionBaseState, netBaseDelta: 101n, lastMarkPrice: 2_000n },
      config: { hedgeThresholdBase: 100n },
      now: 10n,
      maxHedgeSlippageBps: 100n,
    });

    expect(inside).toMatchObject({ kind: 'skip', reason: 'inside-threshold' });
    expect(outside).toMatchObject({ kind: 'rebalance', hedgeBaseDelta: -101n });
  });

  it('computes acceptable prices for long and short hedge deltas', () => {
    expect(computeAcceptablePrice(2_000n, 1n, 100n)).toBe(2_020n);
    expect(computeAcceptablePrice(2_000n, -1n, 100n)).toBe(1_980n);
  });
});
