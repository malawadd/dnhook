import type { Address, Hash, Hex } from 'viem';
import { makeWalletClient, makeWritePublicClient } from './clients.js';
import { TxCoordinator, type TxAttempt, type TxCoordinatorOptions } from './txCoordinator.js';

export type RpcRouterEvent = (kind: 'info' | 'warning', message: string, extra?: { trader?: string; txHash?: string }) => void;

export type RpcEndpointStatus = {
  label: string;
  active: boolean;
  coolingDown: boolean;
  cooldownMs: number;
  failures: number;
  retries: number;
};

export type TraderRpcStatus = {
  label: string;
  coolingDown: boolean;
  cooldownMs: number;
  lastError?: string;
};

type RpcEndpoint = {
  label: string;
  url: string;
  coordinator: Pick<TxCoordinator, 'nonces' | 'send'>;
  cooldownUntil: number;
  failures: number;
  retries: number;
  lastError?: string;
};

type TraderSendInput = {
  traderId: number;
  address: Address;
  privateKey: Hex;
  label: string;
  send: (input: { walletClient: ReturnType<typeof makeWalletClient>['walletClient']; attempt: TxAttempt; rpcLabel: string }) => Promise<Hash>;
};

type RouterFactories = {
  makeCoordinator?: (url: string, options: TxCoordinatorOptions) => Pick<TxCoordinator, 'nonces' | 'send'>;
  makeWallet?: (privateKey: Hex, rpcUrl: string) => ReturnType<typeof makeWalletClient>;
};

export class TraderRpcRouter {
  readonly #endpoints: RpcEndpoint[];
  readonly #activeByTrader = new Map<Address, number>();

  constructor(
    rpcUrls: string[],
    readonly options: TxCoordinatorOptions & {
      cooldownMs: number;
      retryAttempts: number;
      onEvent?: RpcRouterEvent;
    },
    readonly factories: RouterFactories = {},
  ) {
    this.#endpoints = rpcUrls.map((url, index) => ({
      label: `rpc-${index + 1}`,
      url,
      coordinator:
        factories.makeCoordinator?.(url, options) ?? new TxCoordinator(makeWritePublicClient(url), options),
      cooldownUntil: 0,
      failures: 0,
      retries: 0,
    }));
    if (this.#endpoints.length === 0) throw new Error('At least one trader write RPC is required.');
  }

  async sendTrader(input: TraderSendInput) {
    let endpoint = this.#endpointFor(input.address, input.traderId);
    const maxAttempts = Math.max(1, this.options.retryAttempts);
    let lastError: unknown;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
      endpoint = this.#availableEndpoint(endpoint, input.address, input.traderId);
      try {
        const { walletClient } = (this.factories.makeWallet ?? makeWalletClient)(input.privateKey, endpoint.url);
        const hash = await endpoint.coordinator.send(input.address, `${input.label} via ${endpoint.label}`, (attempt) =>
          input.send({ walletClient, attempt, rpcLabel: endpoint.label }),
        );
        this.#activeByTrader.set(input.address, this.#endpoints.indexOf(endpoint));
        endpoint.lastError = undefined;
        return { hash, rpcLabel: endpoint.label };
      } catch (error) {
        lastError = error;
        if (!isProviderRetryableError(error) || attemptIndex >= maxAttempts - 1) throw error;
        this.#cooldown(endpoint, error);
        endpoint.retries++;
        this.options.onEvent?.('warning', `${input.label}: ${endpoint.label} rate-limited or unavailable; retrying another RPC.`, {
          trader: input.address,
        });
        endpoint = this.#nextEndpoint(endpoint);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async nonces(address: Address, traderId: number) {
    return this.#endpointFor(address, traderId).coordinator.nonces(address);
  }

  traderStatus(address: Address, traderId: number): TraderRpcStatus {
    const endpoint = this.#endpointFor(address, traderId);
    const cooldownMs = Math.max(0, endpoint.cooldownUntil - Date.now());
    return {
      label: endpoint.label,
      coolingDown: cooldownMs > 0,
      cooldownMs,
      lastError: endpoint.lastError,
    };
  }

  health(): RpcEndpointStatus[] {
    const now = Date.now();
    return this.#endpoints.map((endpoint) => ({
      label: endpoint.label,
      active: endpoint.cooldownUntil <= now,
      coolingDown: endpoint.cooldownUntil > now,
      cooldownMs: Math.max(0, endpoint.cooldownUntil - now),
      failures: endpoint.failures,
      retries: endpoint.retries,
    }));
  }

  #endpointFor(address: Address, traderId: number) {
    const active = this.#activeByTrader.get(address);
    if (active !== undefined) return this.#endpoints[active];
    const index = stableIndex(`${traderId}:${address.toLowerCase()}`, this.#endpoints.length);
    this.#activeByTrader.set(address, index);
    return this.#endpoints[index];
  }

  #availableEndpoint(preferred: RpcEndpoint, address: Address, traderId: number) {
    if (preferred.cooldownUntil <= Date.now()) return preferred;
    const start = this.#endpoints.indexOf(preferred);
    for (let offset = 1; offset <= this.#endpoints.length; offset++) {
      const candidate = this.#endpoints[(start + offset) % this.#endpoints.length];
      if (candidate.cooldownUntil <= Date.now()) {
        this.#activeByTrader.set(address, this.#endpoints.indexOf(candidate));
        this.options.onEvent?.('info', `Trader ${traderId} using ${candidate.label} while ${preferred.label} cools down.`, {
          trader: address,
        });
        return candidate;
      }
    }
    return preferred;
  }

  #nextEndpoint(endpoint: RpcEndpoint) {
    return this.#endpoints[(this.#endpoints.indexOf(endpoint) + 1) % this.#endpoints.length];
  }

  #cooldown(endpoint: RpcEndpoint, error: unknown) {
    endpoint.failures++;
    endpoint.lastError = cleanError(error);
    endpoint.cooldownUntil = Date.now() + this.options.cooldownMs;
  }
}

export function isProviderRetryableError(error: unknown) {
  const message = cleanError(error).toLowerCase();
  if (message.includes('execution reverted') || message.includes('insufficient funds')) return false;
  return (
    message.includes('429') ||
    message.includes('too many request') ||
    message.includes('rate limit') ||
    message.includes('request limit') ||
    message.includes('temporarily unavailable') ||
    message.includes('timeout') ||
    message.includes('network error') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('etimedout')
  );
}

export function stableIndex(value: string, modulo: number) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash % modulo;
}

function cleanError(error: unknown) {
  if (error instanceof Error) return error.message.split('\n')[0] || error.message;
  return String(error);
}
