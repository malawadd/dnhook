import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import { PendingNonceGapError, TxCoordinator, bumpFee } from './txCoordinator.js';

const ADDRESS = '0x0000000000000000000000000000000000000001' as Address;

describe('TxCoordinator', () => {
  it('serializes transactions from one wallet with explicit nonces', async () => {
    const attempts: number[] = [];
    const client = fakeClient({ latestNonce: 7, pendingNonce: 7 });
    const coordinator = new TxCoordinator(client, { replacementFeeBumpBps: 2500n, nonceConfirmTimeoutMs: 100 });

    const [first, second] = await Promise.all([
      coordinator.send(ADDRESS, 'first', async ({ nonce }) => {
        attempts.push(nonce);
        await sleep(5);
        return '0x01' as Hash;
      }),
      coordinator.send(ADDRESS, 'second', async ({ nonce }) => {
        attempts.push(nonce);
        return '0x02' as Hash;
      }),
    ]);

    expect(first).toBe('0x01');
    expect(second).toBe('0x02');
    expect(attempts).toEqual([7, 8]);
  });

  it('retries once with bumped fees when there is no pending nonce gap', async () => {
    const attempts: Array<{ nonce: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> = [];
    const warnings: string[] = [];
    const client = fakeClient({ latestNonce: 5, pendingNonce: 5, maxFeePerGas: 100n, maxPriorityFeePerGas: 4n });
    const coordinator = new TxCoordinator(client, {
      replacementFeeBumpBps: 2500n,
      nonceConfirmTimeoutMs: 100,
      onEvent: (_kind, message) => warnings.push(message),
    });

    const hash = await coordinator.send(ADDRESS, 'approve', async (attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) throw new Error('replacement transaction underpriced');
      return '0x03' as Hash;
    });

    expect(hash).toBe('0x03');
    expect(attempts).toEqual([
      { nonce: 5 },
      { nonce: 5, maxFeePerGas: 125n, maxPriorityFeePerGas: 5n },
    ]);
    expect(warnings.at(0)).toContain('retrying with fee bump');
  });

  it('pauses the sender when replacement underpriced points at a pending nonce gap', async () => {
    const client = fakeClient({ latestNonce: 2, pendingNonce: 3 });
    const coordinator = new TxCoordinator(client, { replacementFeeBumpBps: 2500n, nonceConfirmTimeoutMs: 1 });

    await expect(
      coordinator.send(ADDRESS, 'approve', async () => {
        throw new Error('replacement transaction underpriced');
      }),
    ).rejects.toBeInstanceOf(PendingNonceGapError);
  });

  it('retries after a pending nonce gap clears inside the wait window', async () => {
    const attempts: Array<{ nonce: number; maxFeePerGas?: bigint }> = [];
    let nonceReads = 0;
    const client = {
      getTransactionCount: async ({ blockTag }: { blockTag: 'latest' | 'pending' }) => {
        const round = Math.floor(nonceReads / 2);
        nonceReads++;
        if (round < 2) return blockTag === 'latest' ? 2 : 3;
        return 3;
      },
      waitForTransactionReceipt: async () => ({ status: 'success' as const }),
      estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 4n }),
    };
    const coordinator = new TxCoordinator(client, { replacementFeeBumpBps: 2500n, nonceConfirmTimeoutMs: 100 });

    const hash = await coordinator.send(ADDRESS, 'approve', async (attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) throw new Error('replacement transaction underpriced');
      return '0x04' as Hash;
    });

    expect(hash).toBe('0x04');
    expect(attempts).toEqual([
      { nonce: 3 },
      { nonce: 3, maxFeePerGas: 125n, maxPriorityFeePerGas: 5n },
    ]);
  });

  it('bumps fees by basis points', () => {
    expect(bumpFee(100n, 2500n)).toBe(125n);
    expect(bumpFee(undefined, 2500n)).toBeUndefined();
  });
});

function fakeClient(options: {
  latestNonce: number;
  pendingNonce: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}) {
  return {
    getTransactionCount: async ({ blockTag }: { blockTag: 'latest' | 'pending' }) =>
      blockTag === 'pending' ? options.pendingNonce : options.latestNonce,
    waitForTransactionReceipt: async () => ({ status: 'success' as const }),
    estimateFeesPerGas: async () => ({
      maxFeePerGas: options.maxFeePerGas ?? 100n,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? 2n,
    }),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
