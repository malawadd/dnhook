import type { Abi } from 'viem';

const poolKeyComponents = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

const swapParamsComponents = [
  { name: 'zeroForOne', type: 'bool' },
  { name: 'amountSpecified', type: 'int256' },
  { name: 'sqrtPriceLimitX96', type: 'uint160' },
] as const;

export const deltaNeutralHookAbi = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'keepers',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'allowed', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'priceUpdaters',
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
    name: 'previewFee',
    stateMutability: 'view',
    inputs: [
      { name: 'key', type: 'tuple', components: poolKeyComponents },
      { name: 'params', type: 'tuple', components: swapParamsComponents },
    ],
    outputs: [{ name: 'feePips', type: 'uint24' }],
  },
  {
    type: 'function',
    name: 'updateReferencePrice',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'tuple', components: poolKeyComponents },
      { name: 'referencePriceX96', type: 'uint256' },
    ],
    outputs: [],
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
  {
    type: 'function',
    name: 'setPoolPaused',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'tuple', components: poolKeyComponents },
      { name: 'paused', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'HedgeIntent',
    inputs: [
      { name: 'poolId', type: 'bytes32', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: true },
      { name: 'netBaseDelta', type: 'int256', indexed: false },
      { name: 'hedgeBaseDelta', type: 'int256', indexed: false },
      { name: 'referencePriceX96', type: 'uint256', indexed: false },
    ],
  },
] as const satisfies Abi;

export const demoErc20Abi = [
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: 'allowance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'faucet',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

export const poolSwapTestAbi = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      { name: 'key', type: 'tuple', components: poolKeyComponents },
      { name: 'params', type: 'tuple', components: swapParamsComponents },
      {
        name: 'testSettings',
        type: 'tuple',
        components: [
          { name: 'takeClaims', type: 'bool' },
          { name: 'settleUsingBurn', type: 'bool' },
        ],
      },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'delta', type: 'int256' }],
  },
] as const satisfies Abi;

