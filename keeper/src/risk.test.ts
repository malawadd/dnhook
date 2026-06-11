import { describe, expect, it } from 'vitest';
import { decideHedgeFill, type RiskState } from './risk.js';

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
