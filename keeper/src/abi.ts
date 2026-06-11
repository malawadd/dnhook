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

const liquidityParamsComponents = [
  { name: 'tickLower', type: 'int24' },
  { name: 'tickUpper', type: 'int24' },
  { name: 'liquidityDelta', type: 'int256' },
  { name: 'salt', type: 'bytes32' },
] as const;

export const capstoneHookAbi = [
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

const productionRiskStateComponents = [
  { name: 'poolBaseExposure', type: 'int256' },
  { name: 'hedgePositionBase', type: 'int256' },
  { name: 'targetHedgeBase', type: 'int256' },
  { name: 'pendingOrderBase', type: 'int256' },
  { name: 'netBaseDelta', type: 'int256' },
  { name: 'realizedPnlUsd', type: 'int256' },
  { name: 'unrealizedPnlUsd', type: 'int256' },
  { name: 'collateralUsd', type: 'uint256' },
  { name: 'initialCollateralUsd', type: 'uint256' },
  { name: 'lastMarkPrice', type: 'uint256' },
  { name: 'lastSnapshotTimestamp', type: 'uint256' },
  { name: 'pendingOrderReadyAt', type: 'uint256' },
  { name: 'lastRebalanceTimestamp', type: 'uint256' },
  { name: 'lpBaseDeposited', type: 'uint256' },
  { name: 'lpBaseWithdrawn', type: 'uint256' },
  { name: 'lpBaseFeesAccrued', type: 'uint256' },
  { name: 'pendingOrderId', type: 'bytes32' },
  { name: 'adapterHealthy', type: 'bool' },
  { name: 'healthMode', type: 'uint8' },
] as const;

const productionPoolConfigComponents = [
  { name: 'configured', type: 'bool' },
  { name: 'baseIsCurrency0', type: 'bool' },
  { name: 'minFeePips', type: 'uint24' },
  { name: 'targetFeePips', type: 'uint24' },
  { name: 'maxFeePips', type: 'uint24' },
  { name: 'inventoryFeeBumpPips', type: 'uint24' },
  { name: 'inventoryFeeDiscountPips', type: 'uint24' },
  { name: 'hedgeThresholdBase', type: 'uint256' },
  { name: 'maxResidualDeltaBase', type: 'uint256' },
  { name: 'maxPendingOrderAge', type: 'uint256' },
  { name: 'maxSnapshotAge', type: 'uint256' },
  { name: 'minCollateralUsd', type: 'uint256' },
  { name: 'minCollateralRatioBps', type: 'uint256' },
  { name: 'maxLeverageBps', type: 'uint256' },
  { name: 'maxLossBps', type: 'uint256' },
] as const;

export const productionHookAbi = [
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
    outputs: [{ name: '', type: 'tuple', components: productionRiskStateComponents }],
  },
  {
    type: 'function',
    name: 'getPoolConfig',
    stateMutability: 'view',
    inputs: [{ name: 'key', type: 'tuple', components: poolKeyComponents }],
    outputs: [{ name: '', type: 'tuple', components: productionPoolConfigComponents }],
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
    name: 'syncHedgeSnapshot',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'key', type: 'tuple', components: poolKeyComponents }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rebalance',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'tuple', components: poolKeyComponents },
      { name: 'acceptablePrice', type: 'uint256' },
    ],
    outputs: [{ name: 'orderId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'settleHedgeOrder',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'key', type: 'tuple', components: poolKeyComponents }],
    outputs: [],
  },
] as const satisfies Abi;

export const demoErc20Abi = [
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

export const productionLiquidityRouterAbi = [
  {
    type: 'function',
    name: 'modifyLiquidity',
    stateMutability: 'payable',
    inputs: [
      { name: 'key', type: 'tuple', components: poolKeyComponents },
      { name: 'params', type: 'tuple', components: liquidityParamsComponents },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'delta', type: 'int256' }],
  },
] as const satisfies Abi;

export const demoHedgeAdapterAbi = [
  {
    type: 'function',
    name: 'setHealthy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'healthy', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setNextSettlement',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'fillBase', type: 'int256' },
      { name: 'realizedPnlUsd', type: 'int256' },
      { name: 'markPrice', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'resetDemoSnapshot',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'markPrice', type: 'uint256' },
      { name: 'collateralUsd', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;
