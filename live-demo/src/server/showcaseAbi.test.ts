import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseUnits } from 'viem';
import { demoHedgeAdapterAbi } from './abi.js';

describe('showcase adapter ABI', () => {
  it('encodes the economics controls used by fork showcase mode', () => {
    const strategyId = `0x${'00'.repeat(32)}` as const;
    const encoded = [
      encodeFunctionData({
        abi: demoHedgeAdapterAbi,
        functionName: 'setNextSettlement',
        args: [strategyId, 0n, -parseUnits('5000', 18), parseUnits('2100', 18)],
      }),
      encodeFunctionData({
        abi: demoHedgeAdapterAbi,
        functionName: 'setPnl',
        args: [strategyId, -parseUnits('5000', 18), -parseUnits('2500', 18)],
      }),
      encodeFunctionData({
        abi: demoHedgeAdapterAbi,
        functionName: 'setCollateralUsd',
        args: [strategyId, parseUnits('500', 18)],
      }),
      encodeFunctionData({
        abi: demoHedgeAdapterAbi,
        functionName: 'makeSnapshotStale',
        args: [strategyId, 600n],
      }),
    ];

    expect(encoded.every((value) => value.startsWith('0x'))).toBe(true);
  });
});
