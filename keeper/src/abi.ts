import type { Abi } from 'viem';

const poolKeyComponents = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export const deltaNeutralHookAbi = [
  {
    type: 'function',
    name: 'keepers',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'allowed', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getRiskState',
    stateMutability: 'view',
    inputs: [{ name: 'key', type: 'tuple', components: poolKeyComponents }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'poolBaseExposure', type: 'int256' },
          { name: 'reportedHedgeBase', type: 'int256' },
          { name: 'pendingHedgeBase', type: 'int256' },
          { name: 'lastReferencePriceX96', type: 'uint256' },
          { name: 'lastReferenceTimestamp', type: 'uint256' },
          { name: 'hedgeNonce', type: 'uint256' },
          { name: 'paused', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'netBaseDelta',
    stateMutability: 'view',
    inputs: [{ name: 'key', type: 'tuple', components: poolKeyComponents }],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    type: 'function',
    name: 'recordHedgeFill',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'tuple', components: poolKeyComponents },
      { name: 'nonce', type: 'uint256' },
      { name: 'hedgeBaseDelta', type: 'int256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;
