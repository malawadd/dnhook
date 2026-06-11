import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export function makePublicClient(rpcUrl: string) {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
}

export function makeWalletClient(privateKey: Hex, rpcUrl: string) {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    walletClient: createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) }),
  };
}
