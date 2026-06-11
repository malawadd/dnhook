import { describe, expect, it } from 'vitest';
import { chunkBlockRange, collectLogsInChunks, initialBackfillFromBlock, nextBlockAfterFailedRange } from './logRanges.js';

describe('log range helpers', () => {
  it('chunks ranges without exceeding the provider span', () => {
    const ranges = chunkBlockRange(100n, 140n, 10);
    expect(ranges).toEqual([
      { fromBlock: 100n, toBlock: 109n },
      { fromBlock: 110n, toBlock: 119n },
      { fromBlock: 120n, toBlock: 129n },
      { fromBlock: 130n, toBlock: 139n },
      { fromBlock: 140n, toBlock: 140n },
    ]);
    expect(ranges.every((range) => range.toBlock - range.fromBlock + 1n <= 10n)).toBe(true);
  });

  it('respects the configured initial backfill', () => {
    expect(initialBackfillFromBlock(1_000n, 40)).toBe(960n);
    expect(initialBackfillFromBlock(20n, 40)).toBe(0n);
  });

  it('advances past a failed chunk so the scanner does not loop forever', () => {
    expect(nextBlockAfterFailedRange({ fromBlock: 100n, toBlock: 109n })).toBe(110n);
  });

  it('collects successful chunks without throwing when one chunk fails', async () => {
    const errors: string[] = [];
    const logs = await collectLogsInChunks({
      fromBlock: 1n,
      toBlock: 12n,
      maxSpan: 5,
      getLogs: async (range) => {
        if (range.fromBlock === 6n) throw new Error('provider range limit');
        return [`${range.fromBlock}-${range.toBlock}`];
      },
      onChunkError: (range) => errors.push(`${range.fromBlock}-${range.toBlock}`),
    });

    expect(logs).toEqual(['1-5', '11-12']);
    expect(errors).toEqual(['6-10']);
  });
});
