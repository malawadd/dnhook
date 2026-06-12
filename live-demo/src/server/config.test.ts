import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { loadLiveConfig } from './config.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of [
    'BASE_SEPOLIA_RPC_URL',
    'BASE_SEPOLIA_RPC_URLS',
    'BASE_SEPOLIA_WRITE_RPC_URL',
    'BASE_SEPOLIA_WRITE_RPC_URLS',
    'LIVE_MODE',
    'LIVE_FORK_RPC_URL',
    'LIVE_FORK_TRADER_COUNT',
    'LIVE_FORK_TRADER_FUNDING_ETH',
    'LIVE_TRADER_COUNT',
    'LIVE_TRADER_FUNDING_ETH',
    'LIVE_SWAP_INTERVAL_MS',
    'LIVE_KEEPER_INTERVAL_MS',
    'LIVE_MAX_TX_PER_MIN',
  ]) {
    delete process.env[key];
  }
  process.env.PRIVATE_KEY = `0x${'11'.repeat(32)}`;
});

afterEach(() => {
  process.env = originalEnv;
});

describe('live demo config', () => {
  it('forces fork mode reads and writes to local Anvil defaults', () => {
    process.env.LIVE_MODE = 'fork';

    const config = loadLiveConfig();

    expect(config.mode).toBe('fork');
    expect(config.rpcUrl).toBe('http://127.0.0.1:8545');
    expect(config.rpcUrls).toEqual(['http://127.0.0.1:8545']);
    expect(config.writeRpcUrl).toBe('http://127.0.0.1:8545');
    expect(config.writeRpcUrls).toEqual(['http://127.0.0.1:8545']);
    expect(config.traderStateFile).toBe('fork-traders.json');
    expect(config.traderCount).toBe(5);
    expect(config.traderFundingWei).toBe(parseEther('0.02'));
    expect(config.maxTxPerMinute).toBe(90);
  });

  it('lets fork mode use an explicit local RPC URL and trader count', () => {
    process.env.LIVE_MODE = 'fork';
    process.env.LIVE_FORK_RPC_URL = 'http://localhost:9545';
    process.env.LIVE_FORK_TRADER_COUNT = '3';

    const config = loadLiveConfig();

    expect(config.rpcUrls).toEqual(['http://localhost:9545']);
    expect(config.writeRpcUrls).toEqual(['http://localhost:9545']);
    expect(config.traderCount).toBe(3);
  });

  it('keeps fork trader funding separate from live trader funding', () => {
    process.env.LIVE_MODE = 'fork';
    process.env.LIVE_TRADER_FUNDING_ETH = '0.1';

    const config = loadLiveConfig();

    expect(config.traderFundingWei).toBe(parseEther('0.02'));
  });

  it('lets fork mode override trader funding explicitly', () => {
    process.env.LIVE_MODE = 'fork';
    process.env.LIVE_TRADER_FUNDING_ETH = '0.1';
    process.env.LIVE_FORK_TRADER_FUNDING_ETH = '0.03';

    const config = loadLiveConfig();

    expect(config.traderFundingWei).toBe(parseEther('0.03'));
  });
});
