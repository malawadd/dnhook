import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const forkRpcUrl = process.env.LIVE_FORK_RPC_URL || 'http://127.0.0.1:8545';

export function loadEnvFiles() {
  for (const path of [resolve('..', '.env'), resolve('.env')]) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function forkEnvOverrides() {
  return {
    LIVE_MODE: 'fork',
    LIVE_FORK_RPC_URL: forkRpcUrl,
    LIVE_TRADER_COUNT: process.env.LIVE_FORK_TRADER_COUNT || process.env.LIVE_TRADER_COUNT || '5',
    LIVE_FORK_TRADER_FUNDING_ETH: process.env.LIVE_FORK_TRADER_FUNDING_ETH || '0.02',
    LIVE_TRADER_FUNDING_ETH: process.env.LIVE_FORK_TRADER_FUNDING_ETH || '0.02',
    LIVE_SWAP_INTERVAL_MS: process.env.LIVE_SWAP_INTERVAL_MS || '1500',
    LIVE_KEEPER_INTERVAL_MS: process.env.LIVE_KEEPER_INTERVAL_MS || '3000',
    LIVE_MAX_TX_PER_MIN: process.env.LIVE_MAX_TX_PER_MIN || '90',
    BASE_SEPOLIA_RPC_URLS: forkRpcUrl,
    BASE_SEPOLIA_WRITE_RPC_URL: forkRpcUrl,
    BASE_SEPOLIA_WRITE_RPC_URLS: forkRpcUrl,
  };
}

export function anvilArgs() {
  const forkUrl = process.env.BASE_SEPOLIA_RPC_URL;
  if (!forkUrl) throw new Error('BASE_SEPOLIA_RPC_URL is required to start the Base Sepolia fork.');
  const args = ['--fork-url', forkUrl, '--chain-id', '84532', '--host', '127.0.0.1', '--port', '8545'];
  if (process.env.LIVE_FORK_BLOCK_NUMBER) args.push('--fork-block-number', process.env.LIVE_FORK_BLOCK_NUMBER);
  return args;
}
