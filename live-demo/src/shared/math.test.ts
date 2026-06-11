import { describe, expect, it } from 'vitest';
import { clampTraderCount, parseFundingTarget, tickToBaseQuotePrice, txIntervalFromRateLimit, chooseHealthLabel, ZERO_HASH } from './math.js';

describe('live demo safeguards', () => {
  it('caps trader count at ten', () => {
    expect(clampTraderCount(25)).toBe(10);
    expect(clampTraderCount(0)).toBe(1);
  });

  it('rejects funding above the per-trader hard cap', () => {
    expect(() => parseFundingTarget('0.11')).toThrow(/capped/);
    expect(parseFundingTarget('0.05')).toBeGreaterThan(0n);
  });

  it('derives a minimum interval from the tx rate limit', () => {
    expect(txIntervalFromRateLimit(30)).toBe(2000);
  });

  it('labels pending orders before ordinary rebalance states', () => {
    expect(
      chooseHealthLabel({
        netBaseDelta: 100n,
        hedgeThresholdBase: 10n,
        pendingOrderBase: 1n,
        pendingOrderId: ZERO_HASH,
        adapterHealthy: true,
        healthMode: 1,
      }),
    ).toBe('Order pending');
  });

  it('converts ticks into the displayed base quote direction', () => {
    expect(tickToBaseQuotePrice(0, true)).toBe(1);
    expect(tickToBaseQuotePrice(0, false)).toBe(1);
  });
});
