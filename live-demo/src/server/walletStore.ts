import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { LiveDemoConfig } from './config.js';

export type StoredTrader = {
  id: number;
  address: Address;
  privateKey: Hex;
};

type TraderFile = {
  version: 1;
  traders: StoredTrader[];
};

export function loadOrCreateTraders(config: LiveDemoConfig): StoredTrader[] {
  mkdirSync(config.stateDir, { recursive: true });
  const filePath = tradersPath(config);
  const existing = existsSync(filePath) ? readTraderFile(filePath).traders : [];
  const traders = [...existing];

  while (traders.length < config.traderCount) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    traders.push({ id: traders.length + 1, address: account.address, privateKey });
  }

  const selected = traders.slice(0, config.traderCount);
  writeFileSync(filePath, JSON.stringify({ version: 1, traders: selected }, null, 2));
  return selected;
}

export function readTraders(config: LiveDemoConfig): StoredTrader[] {
  const filePath = tradersPath(config);
  if (!existsSync(filePath)) return [];
  return readTraderFile(filePath).traders.slice(0, config.traderCount);
}

export function rotateTraders(config: LiveDemoConfig): StoredTrader[] {
  if (!config.allowWalletRotation) {
    throw new Error('Set LIVE_ALLOW_WALLET_ROTATION=true before rotating demo trader wallets.');
  }
  mkdirSync(config.stateDir, { recursive: true });
  const filePath = tradersPath(config);
  if (existsSync(filePath)) {
    copyFileSync(filePath, resolve(config.stateDir, `traders.${timestamp()}.json`));
  }
  const traders: StoredTrader[] = [];
  while (traders.length < config.traderCount) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    traders.push({ id: traders.length + 1, address: account.address, privateKey });
  }
  writeFileSync(filePath, JSON.stringify({ version: 1, traders }, null, 2));
  return traders;
}

function tradersPath(config: LiveDemoConfig) {
  return resolve(config.stateDir, 'traders.json');
}

function readTraderFile(path: string): TraderFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as TraderFile;
  if (!Array.isArray(parsed.traders)) throw new Error('Invalid trader state file.');
  return parsed;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
