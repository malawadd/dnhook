export type BlockRange = {
  fromBlock: bigint;
  toBlock: bigint;
};

export function initialBackfillFromBlock(toBlock: bigint, backfillBlocks: number) {
  const backfill = BigInt(Math.max(0, Math.trunc(backfillBlocks)));
  return toBlock > backfill ? toBlock - backfill : 0n;
}

export function chunkBlockRange(fromBlock: bigint, toBlock: bigint, maxSpan: number): BlockRange[] {
  if (fromBlock > toBlock) return [];
  const safeSpan = BigInt(Math.max(1, Math.trunc(maxSpan)));
  const ranges: BlockRange[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = minBigInt(cursor + safeSpan - 1n, toBlock);
    ranges.push({ fromBlock: cursor, toBlock: end });
    cursor = end + 1n;
  }
  return ranges;
}

export function nextBlockAfterFailedRange(range: BlockRange) {
  return range.toBlock + 1n;
}

export async function collectLogsInChunks<TLog>(input: {
  fromBlock: bigint;
  toBlock: bigint;
  maxSpan: number;
  getLogs: (range: BlockRange) => Promise<TLog[]>;
  onChunkError?: (range: BlockRange, error: unknown) => void;
}) {
  const logs: TLog[] = [];
  for (const range of chunkBlockRange(input.fromBlock, input.toBlock, input.maxSpan)) {
    try {
      logs.push(...(await input.getLogs(range)));
    } catch (error) {
      input.onChunkError?.(range, error);
    }
  }
  return logs;
}

function minBigInt(a: bigint, b: bigint) {
  return a < b ? a : b;
}
