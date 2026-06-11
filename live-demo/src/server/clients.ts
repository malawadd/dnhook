import { createPublicClient, createWalletClient, fallback, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export function makePublicClient(rpcUrls: string[]) {
  const urls = rpcUrls.length > 0 ? rpcUrls : ['https://sepolia.base.org'];
  return createPublicClient({
    chain: baseSepolia,
    transport: urls.length === 1 ? http(urls[0]) : fallback(urls.map((url) => http(url))),
  });
}

export function makeWritePublicClient(rpcUrl: string) {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
}

export function makeWalletClient(privateKey: Hex, rpcUrl: string) {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    walletClient: createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) }),
  };
}
