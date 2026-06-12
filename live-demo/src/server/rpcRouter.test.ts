import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { TraderRpcRouter, isProviderRetryableError, stableIndex } from './rpcRouter.js';
import type { TxAttempt, TxCoordinatorOptions } from './txCoordinator.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const URLS = ['https://rpc-a.example', 'https://rpc-b.example', 'https://rpc-c.example'];

describe('TraderRpcRouter', () => {
  it('assigns traders to a stable spread of RPCs', async () => {
    const calls: string[] = [];
    const router = testRouter({
      onSend: async (url, send) => {
        calls.push(url);
        return send({ nonce: 0 });
      },
    });

    for (let id = 1; id <= 9; id++) {
      const address = addressFor(id);
      await router.sendTrader({
        traderId: id,
        address,
        privateKey: PRIVATE_KEY,
        label: `trader ${id}`,
        send: async () => `0x${id}` as `0x${string}`,
      });
    }

    expect(new Set(calls).size).toBeGreaterThan(1);
    expect(router.traderStatus(addressFor(1), 1).label).toBe(router.traderStatus(addressFor(1), 1).label);
  });

  it('retries a rate-limited trader write on a different RPC', async () => {
    const address = addressAssignedTo(0);
    const calls: string[] = [];
    const router = testRouter({
      onSend: async (url, send) => {
        calls.push(url);
        if (calls.length === 1) throw new Error('HTTP 429 too many requests');
        return send({ nonce: 0 });
      },
    });

    const result = await router.sendTrader({
      traderId: 1,
      address,
      privateKey: PRIVATE_KEY,
      label: 'swap',
      send: async () => '0x1234' as `0x${string}`,
    });

    expect(result.hash).toBe('0x1234');
    expect(calls).toEqual([URLS[0], URLS[1]]);
    expect(router.health()[0].coolingDown).toBe(true);
    expect(router.health()[0].failures).toBe(1);
    expect(router.health()[0].retries).toBe(1);
  });

  it('does not retry contract reverts on another RPC', async () => {
    const calls: string[] = [];
    const router = testRouter({
      onSend: async (url) => {
        calls.push(url);
        throw new Error('execution reverted');
      },
    });

    await expect(
      router.sendTrader({
        traderId: 1,
        address: addressFor(1),
        privateKey: PRIVATE_KEY,
        label: 'swap',
        send: async () => '0x1234' as `0x${string}`,
      }),
    ).rejects.toThrow('execution reverted');

    expect(calls).toHaveLength(1);
  });

  it('skips cooled-down RPCs for other traders', async () => {
    const first = addressAssignedTo(0, 1);
    const second = addressAssignedTo(0, 2);
    const calls: string[] = [];
    const router = testRouter({
      onSend: async (url, send) => {
        calls.push(url);
        if (calls.length === 1) throw new Error('rate limit');
        return send({ nonce: 0 });
      },
    });

    await router.sendTrader({
      traderId: 1,
      address: first,
      privateKey: PRIVATE_KEY,
      label: 'first swap',
      send: async () => '0x1' as `0x${string}`,
    });
    await router.sendTrader({
      traderId: 2,
      address: second,
      privateKey: PRIVATE_KEY,
      label: 'second swap',
      send: async () => '0x2' as `0x${string}`,
    });

    expect(calls).toEqual([URLS[0], URLS[1], URLS[1]]);
  });

  it('classifies retryable provider errors conservatively', () => {
    expect(isProviderRetryableError(new Error('too many requests'))).toBe(true);
    expect(isProviderRetryableError(new Error('temporarily unavailable'))).toBe(true);
    expect(isProviderRetryableError(new Error('execution reverted'))).toBe(false);
    expect(isProviderRetryableError(new Error('insufficient funds'))).toBe(false);
  });
});

function testRouter(input: { onSend: (url: string, send: (attempt: TxAttempt) => Promise<`0x${string}`>) => Promise<`0x${string}`> }) {
  return new TraderRpcRouter(
    URLS,
    {
      replacementFeeBumpBps: 2500n,
      nonceConfirmTimeoutMs: 100,
      cooldownMs: 30_000,
      retryAttempts: 2,
    },
    {
      makeCoordinator: (url: string, _options: TxCoordinatorOptions) => ({
        nonces: async () => ({ latestNonce: 0, pendingNonce: 0 }),
        send: async (_address, _label, send) => input.onSend(url, send),
      }),
      makeWallet: () => ({ account: { address: addressFor(999) }, walletClient: {} }) as never,
    },
  );
}

function addressAssignedTo(index: number, salt = 1) {
  for (let id = salt; id < 10_000; id++) {
    const address = addressFor(id);
    if (stableIndex(`${id}:${address.toLowerCase()}`, URLS.length) === index) return address;
  }
  throw new Error(`No address found for index ${index}.`);
}

function addressFor(id: number): Address {
  return `0x${id.toString(16).padStart(40, '0')}` as Address;
}
