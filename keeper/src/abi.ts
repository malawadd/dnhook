import type { Abi } from 'viem';

const poolKeyComponents = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
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
