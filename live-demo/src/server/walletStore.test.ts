import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateTraders, rotateTraders } from './walletStore.js';
import type { LiveDemoConfig } from './config.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('wallet store', () => {
  it('blocks rotation unless explicitly enabled', () => {
    const config = testConfig(false);
    loadOrCreateTraders(config);

    expect(() => rotateTraders(config)).toThrow('LIVE_ALLOW_WALLET_ROTATION=true');
  });

  it('archives the old trader file when rotating wallets', () => {
    const config = testConfig(true);
    const original = loadOrCreateTraders(config);
    const rotated = rotateTraders(config);
    const files = readdirSync(config.stateDir);

    expect(rotated).toHaveLength(2);
    expect(rotated.map((trader) => trader.address)).not.toEqual(original.map((trader) => trader.address));
    expect(existsSync(join(config.stateDir, 'traders.json'))).toBe(true);
    expect(files.some((file) => /^traders\..+\.json$/.test(file))).toBe(true);
  });
});

function testConfig(allowWalletRotation: boolean): LiveDemoConfig {
  const stateDir = mkdtempSync(join(tmpdir(), 'dnhook-live-demo-'));
  tempDirs.push(stateDir);
  return {
    stateDir,
    traderCount: 2,
    allowWalletRotation,
  } as LiveDemoConfig;
}
