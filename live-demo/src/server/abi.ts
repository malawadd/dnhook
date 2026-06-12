import { parseAbi, parseAbiItem } from 'viem';

export const demoErc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function faucet()',
]);

export const productionHookAbi = parseAbi([
  'function keepers(address account) view returns (bool)',
  'function getRiskState((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key) view returns ((int256 poolBaseExposure,int256 hedgePositionBase,int256 targetHedgeBase,int256 pendingOrderBase,int256 netBaseDelta,int256 realizedPnlUsd,int256 unrealizedPnlUsd,uint256 collateralUsd,uint256 initialCollateralUsd,uint256 lastMarkPrice,uint256 lastSnapshotTimestamp,uint256 pendingOrderReadyAt,uint256 lastRebalanceTimestamp,uint256 lpBaseDeposited,uint256 lpBaseWithdrawn,uint256 lpBaseFeesAccrued,bytes32 pendingOrderId,bool adapterHealthy,uint8 healthMode))',
  'function getPoolConfig((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key) view returns ((bool configured,bool baseIsCurrency0,uint24 minFeePips,uint24 targetFeePips,uint24 maxFeePips,uint24 inventoryFeeBumpPips,uint24 inventoryFeeDiscountPips,uint256 hedgeThresholdBase,uint256 maxResidualDeltaBase,uint256 maxPendingOrderAge,uint256 maxSnapshotAge,uint256 minCollateralUsd,uint256 minCollateralRatioBps,uint256 maxLeverageBps,uint256 maxLossBps))',
  'function syncHedgeSnapshot((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)',
  'function rebalance((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint256 acceptablePrice) returns (bytes32)',
  'function settleHedgeOrder((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)',
]);

export const demoHedgeAdapterAbi = parseAbi([
  'function setHealthy(bytes32 strategyId,bool healthy)',
  'function resetDemoSnapshot(bytes32 strategyId,uint256 markPrice,uint256 collateralUsd)',
  'function setMarkPrice(bytes32 strategyId,uint256 markPrice)',
  'function setCollateralUsd(bytes32 strategyId,uint256 collateralUsd)',
  'function setPnl(bytes32 strategyId,int256 realizedPnlUsd,int256 unrealizedPnlUsd)',
  'function setNextSettlement(bytes32 strategyId,int256 fillBase,int256 realizedPnlUsd,uint256 markPrice)',
  'function makeSnapshotStale(bytes32 strategyId,uint256 secondsAgo)',
]);

export const poolSwapTestAbi = parseAbi([
  'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,(bool takeClaims,bool settleUsingBurn) testSettings,bytes hookData) payable returns (int256)',
]);

export const poolManagerSwapEvent = parseAbiItem(
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
);
