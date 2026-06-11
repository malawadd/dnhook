import type { Address, Hash } from 'viem';

export type NonceSnapshot = {
  latestNonce: number;
  pendingNonce: number;
};

export type TxAttempt = {
  nonce: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type TxCoordinatorOptions = {
  replacementFeeBumpBps: bigint;
  nonceConfirmTimeoutMs: number;
  onEvent?: (kind: 'info' | 'warning', message: string, extra?: { trader?: string; txHash?: string }) => void;
};

export type TxPublicClient = {
  getTransactionCount(args: { address: Address; blockTag: 'latest' | 'pending' }): Promise<number>;
  waitForTransactionReceipt(args: { hash: Hash; timeout: number }): Promise<{ status: string }>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
};

type Lane = {
  queue: Promise<unknown>;
  nextNonce?: number;
};

export class PendingNonceGapError extends Error {
  readonly name = 'PendingNonceGapError';

  constructor(
    readonly address: Address,
    readonly snapshot: NonceSnapshot,
  ) {
    super(`Pending nonce gap for ${address}: latest=${snapshot.latestNonce} pending=${snapshot.pendingNonce}`);
  }
}

export class TxCoordinator {
  readonly #lanes = new Map<Address, Lane>();

  constructor(
    readonly publicClient: TxPublicClient,
    readonly options: TxCoordinatorOptions,
  ) {}

  async send(address: Address, label: string, send: (attempt: TxAttempt) => Promise<Hash>) {
    const lane = this.#lane(address);
    const task = lane.queue.then(() => this.#sendInLane(address, label, send));
    lane.queue = task.catch(() => undefined);
    return task;
  }

  async nonces(address: Address): Promise<NonceSnapshot> {
    const [latestNonce, pendingNonce] = await Promise.all([
      this.publicClient.getTransactionCount({ address, blockTag: 'latest' }),
      this.publicClient.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    return { latestNonce, pendingNonce };
  }

  resetNonce(address: Address) {
    this.#lane(address).nextNonce = undefined;
  }

  async #sendInLane(address: Address, label: string, send: (attempt: TxAttempt) => Promise<Hash>) {
    const lane = this.#lane(address);
    const nonce = await this.#nextNonce(address);
    try {
      const hash = await send({ nonce });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: this.options.nonceConfirmTimeoutMs });
      if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
      lane.nextNonce = nonce + 1;
      return hash;
    } catch (error) {
      lane.nextNonce = undefined;
      if (!isReplacementUnderpriced(error)) throw error;

      const snapshot = await this.nonces(address);
      if (snapshot.pendingNonce <= snapshot.latestNonce) {
        this.options.onEvent?.('warning', `${label}: replacement transaction underpriced; retrying with fee bump.`, {
          trader: address,
        });
        const hash = await send({ nonce, ...(await this.#feeBumpAttempt()) });
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: this.options.nonceConfirmTimeoutMs });
        if (receipt.status !== 'success') throw new Error(`${label} reverted after fee bump: ${hash}`);
        lane.nextNonce = nonce + 1;
        return hash;
      }

      this.options.onEvent?.(
        'warning',
        `${label}: replacement transaction underpriced; pending nonce gap latest=${snapshot.latestNonce} pending=${snapshot.pendingNonce}.`,
        { trader: address },
      );
      const cleared = await this.#waitForGapOrTimeout(address, snapshot.pendingNonce);
      if (cleared) {
        const freshNonce = await this.#nextNonce(address);
        this.options.onEvent?.('warning', `${label}: pending nonce gap cleared; retrying with fee bump.`, {
          trader: address,
        });
        const hash = await send({ nonce: freshNonce, ...(await this.#feeBumpAttempt()) });
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: this.options.nonceConfirmTimeoutMs });
        if (receipt.status !== 'success') throw new Error(`${label} reverted after pending gap cleared: ${hash}`);
        lane.nextNonce = freshNonce + 1;
        return hash;
      }
      throw new PendingNonceGapError(address, await this.nonces(address));
    }
  }

  async #feeBumpAttempt(): Promise<Pick<TxAttempt, 'maxFeePerGas' | 'maxPriorityFeePerGas'>> {
    const fees = await this.publicClient.estimateFeesPerGas();
    return {
      maxFeePerGas: bumpFee(fees.maxFeePerGas, this.options.replacementFeeBumpBps),
      maxPriorityFeePerGas: bumpFee(fees.maxPriorityFeePerGas, this.options.replacementFeeBumpBps),
    };
  }

  async #nextNonce(address: Address) {
    const lane = this.#lane(address);
    if (lane.nextNonce !== undefined) return lane.nextNonce;
    const snapshot = await this.nonces(address);
    lane.nextNonce = snapshot.pendingNonce;
    return lane.nextNonce;
  }

  async #waitForGapOrTimeout(address: Address, targetNonce: number) {
    if (targetNonce === 0) return true;
    const deadline = Date.now() + this.options.nonceConfirmTimeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await this.nonces(address);
      if (snapshot.latestNonce >= targetNonce || snapshot.pendingNonce === snapshot.latestNonce) {
        this.options.onEvent?.('info', `Pending nonce gap cleared for ${address}.`, { trader: address });
        return true;
      }
      await sleep(Math.min(2500, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  #lane(address: Address) {
    const existing = this.#lanes.get(address);
    if (existing) return existing;
    const lane: Lane = { queue: Promise.resolve() };
    this.#lanes.set(address, lane);
    return lane;
  }
}

export function isReplacementUnderpriced(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('replacement transaction underpriced');
}

export function bumpFee(value: bigint | undefined, bumpBps: bigint) {
  if (value === undefined) return undefined;
  return (value * (10_000n + bumpBps)) / 10_000n;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
