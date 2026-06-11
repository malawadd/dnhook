import { formatUnits, parseEther } from 'viem';
import type { HealthLabel } from './types.js';

export const ZERO_HASH = `0x${'0'.repeat(64)}`;

export function clampTraderCount(value: number) {
  if (!Number.isFinite(value)) return 10;
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

export function parseFundingTarget(value: string) {
  const parsed = parseEther(value);
  const max = parseEther('0.1');
  if (parsed < 0n) throw new Error('LIVE_TRADER_FUNDING_ETH cannot be negative.');
  if (parsed > max) throw new Error('LIVE_TRADER_FUNDING_ETH is capped at 0.1 ETH per trader.');
  return parsed;
}

export function txIntervalFromRateLimit(maxTxPerMinute: number) {
  const safeMax = Math.max(1, Math.min(120, Math.trunc(maxTxPerMinute || 30)));
  return Math.ceil(60_000 / safeMax);
}

export function chooseHealthLabel(input: {
  netBaseDelta: bigint;
  hedgeThresholdBase: bigint;
  pendingOrderBase: bigint;
  pendingOrderId: string;
  adapterHealthy: boolean;
  healthMode: number;
}): HealthLabel {
  if (!input.adapterHealthy || input.healthMode >= 3) return 'Defensive';
  if (input.pendingOrderId !== ZERO_HASH || input.pendingOrderBase !== 0n) return 'Order pending';
  if (abs(input.netBaseDelta) >= input.hedgeThresholdBase) return 'Rebalance needed';
  if (input.netBaseDelta !== 0n) return 'Flow building exposure';
  return 'Neutral';
}

export function bigintToDecimal(value: bigint, decimals = 18, precision = 4) {
  const sign = value < 0n ? '-' : '';
  const absValue = value < 0n ? -value : value;
  const [whole, fraction = ''] = formatUnits(absValue, decimals).split('.');
  const trimmed = fraction.slice(0, precision).replace(/0+$/, '');
  return `${sign}${trimmed ? `${whole}.${trimmed}` : whole}`;
}

export function tickToBaseQuotePrice(tick: number, baseIsCurrency0: boolean) {
  const token1PerToken0 = Math.pow(1.0001, tick);
  return baseIsCurrency0 ? token1PerToken0 : 1 / token1PerToken0;
}

export function boundedRandomAmount(min: bigint, max: bigint, entropy = Math.random()) {
  if (max <= min) return min;
  const spread = max - min;
  const scaled = BigInt(Math.floor(Number(spread / 1_000_000_000_000n) * entropy));
  return min + scaled * 1_000_000_000_000n;
}

function abs(value: bigint) {
  return value < 0n ? -value : value;
}
