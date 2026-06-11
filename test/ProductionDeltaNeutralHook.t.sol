// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {DemoERC20} from "../src/DemoERC20.sol";
import {ProductionDeltaNeutralHook} from "../src/ProductionDeltaNeutralHook.sol";
import {MockHedgeAdapter} from "../src/adapters/MockHedgeAdapter.sol";
import {IHedgeAdapter} from "../src/interfaces/IHedgeAdapter.sol";

contract ProductionDeltaNeutralHookTest is Test, Deployers {
    ProductionDeltaNeutralHook hook;
    MockHedgeAdapter adapter;
    DemoERC20 collateral;

    uint24 internal constant MIN_FEE = 100;
    uint24 internal constant TARGET_FEE = 500;
    uint24 internal constant MAX_FEE = 3_000;
    uint24 internal constant BUMP = 700;
    uint24 internal constant DISCOUNT = 200;
    uint256 internal constant THRESHOLD = 0.01 ether;
    uint256 internal constant MAX_RESIDUAL = 0.005 ether;
    uint256 internal constant COLLATERAL_AMOUNT = 1_000_000 ether;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        collateral = new DemoERC20("Margin USDC", "mUSDC", 18, 10_000_000 ether, 1_000 ether);
        adapter = new MockHedgeAdapter();

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        deployCodeTo(
            "ProductionDeltaNeutralHook.sol",
            abi.encode(manager, collateral, adapter, address(this), address(this)),
            address(flags)
        );
        hook = ProductionDeltaNeutralHook(address(flags));
        adapter.setHook(address(hook));

        (key,) = initPool(currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        _configurePool();

        hook.setLiquidityManager(address(modifyLiquidityRouter), true);
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1_000 ether, salt: 0}),
            ZERO_BYTES
        );

        collateral.approve(address(hook), type(uint256).max);
        hook.depositCollateral(key, COLLATERAL_AMOUNT);
    }

    function test_hookPermissionsUseProductionFlags() public view {
        Hooks.Permissions memory permissions = hook.getHookPermissions();

        assertTrue(permissions.beforeInitialize);
        assertTrue(permissions.beforeAddLiquidity);
        assertTrue(permissions.beforeRemoveLiquidity);
        assertTrue(permissions.beforeSwap);
        assertTrue(permissions.afterSwap);
        assertFalse(permissions.afterAddLiquidity);
        assertFalse(permissions.afterRemoveLiquidity);
    }

    function test_liquidityRouterMustBeWhitelisted() public {
        hook.setLiquidityManager(address(modifyLiquidityRouter), false);

        vm.expectRevert();
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -120, tickUpper: 120, liquidityDelta: 1 ether, salt: bytes32(uint256(1))
            }),
            ZERO_BYTES
        );
    }

    function test_afterSwapTracksExposureAndRequestsRebalance() public {
        swap(key, true, -1 ether, ZERO_BYTES);

        ProductionDeltaNeutralHook.StrategyRiskState memory state = hook.getRiskState(key);
        assertGt(state.poolBaseExposure, 0, "zeroForOne should increase pool base inventory");
        assertEq(state.netBaseDelta, state.poolBaseExposure + state.hedgePositionBase);
        assertEq(state.targetHedgeBase, -state.poolBaseExposure);
        assertEq(uint8(state.healthMode), uint8(ProductionDeltaNeutralHook.HealthMode.NeedsRebalance));
    }

    function test_feeBumpsWorseningFlowAndDiscountsReducingFlow() public {
        swap(key, true, -1 ether, ZERO_BYTES);

        SwapParams memory increaseExposure =
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});
        SwapParams memory reduceExposure =
            SwapParams({zeroForOne: false, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1});

        assertEq(hook.previewFee(key, increaseExposure), TARGET_FEE + BUMP);
        assertEq(hook.previewFee(key, reduceExposure), TARGET_FEE - DISCOUNT);
    }

    function test_rebalanceCommitsAsyncAdapterOrder() public {
        swap(key, true, -1 ether, ZERO_BYTES);

        bytes32 orderId = hook.rebalance(key, 2_000 ether);
        ProductionDeltaNeutralHook.StrategyRiskState memory state = hook.getRiskState(key);
        IHedgeAdapter.HedgeSnapshot memory snapshot = adapter.getSnapshot();

        assertEq(orderId, state.pendingOrderId);
        assertEq(snapshot.pendingOrderBase, state.pendingOrderBase);
        assertEq(state.pendingOrderBase, -state.poolBaseExposure);
        assertEq(uint8(state.healthMode), uint8(ProductionDeltaNeutralHook.HealthMode.PendingOrder));
    }

    function test_pendingOrderCannotBeOverwritten() public {
        swap(key, true, -1 ether, ZERO_BYTES);
        bytes32 orderId = hook.rebalance(key, 2_000 ether);

        vm.expectRevert(abi.encodeWithSelector(ProductionDeltaNeutralHook.PendingOrderExists.selector, orderId));
        hook.rebalance(key, 2_000 ether);
    }

    function test_settleOrderUpdatesHedgePnlAndResidualDelta() public {
        swap(key, true, -1 ether, ZERO_BYTES);
        hook.rebalance(key, 2_000 ether);

        ProductionDeltaNeutralHook.StrategyRiskState memory pending = hook.getRiskState(key);
        adapter.setNextSettlement(pending.pendingOrderBase / 2, 12 ether, 2_010 ether);
        hook.settleHedgeOrder(key);

        ProductionDeltaNeutralHook.StrategyRiskState memory state = hook.getRiskState(key);
        assertEq(state.pendingOrderBase, 0);
        assertEq(state.pendingOrderId, bytes32(0));
        assertEq(state.hedgePositionBase, pending.pendingOrderBase / 2);
        assertEq(state.realizedPnlUsd, 12 ether);
        assertEq(state.lastHedgePrice, 2_010 ether);
        assertEq(state.netBaseDelta, state.poolBaseExposure + state.hedgePositionBase);
        assertEq(uint8(state.healthMode), uint8(ProductionDeltaNeutralHook.HealthMode.NeedsRebalance));
    }

    function test_stalePendingOrderBlocksExposureIncreasingSwaps() public {
        swap(key, true, -1 ether, ZERO_BYTES);
        hook.rebalance(key, 2_000 ether);
        vm.warp(block.timestamp + 2 hours);

        SwapParams memory increaseExposure =
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});
        SwapParams memory reduceExposure =
            SwapParams({zeroForOne: false, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1});

        vm.expectRevert(ProductionDeltaNeutralHook.HedgeAdapterUnhealthy.selector);
        hook.previewFee(key, increaseExposure);

        assertEq(hook.previewFee(key, reduceExposure), TARGET_FEE - DISCOUNT);
    }

    function test_lowCollateralPreventsRebalance() public {
        _setAdapterSnapshot(0, 0, 1, 0, 0, true);
        hook.syncHedgeSnapshot(key);
        swap(key, true, -1 ether, ZERO_BYTES);

        vm.expectRevert(
            abi.encodeWithSelector(ProductionDeltaNeutralHook.InsufficientCollateral.selector, 1, 0.5 ether)
        );
        hook.rebalance(key, 2_000 ether);
    }

    function test_maxLossMovesPoolIntoDefensiveMode() public {
        _setAdapterSnapshot(0, 0, COLLATERAL_AMOUNT, -200_001 ether, 0, true);
        hook.syncHedgeSnapshot(key);

        ProductionDeltaNeutralHook.StrategyRiskState memory state = hook.getRiskState(key);
        assertEq(uint8(state.healthMode), uint8(ProductionDeltaNeutralHook.HealthMode.Defensive));
    }

    function test_emergencyDeRiskFlattensExistingHedgePosition() public {
        _setAdapterSnapshot(-2 ether, 0, COLLATERAL_AMOUNT, 0, 0, true);
        hook.syncHedgeSnapshot(key);

        bytes32 orderId = hook.emergencyDeRisk(key, 2_000 ether);
        ProductionDeltaNeutralHook.StrategyRiskState memory state = hook.getRiskState(key);

        assertEq(orderId, state.pendingOrderId);
        assertEq(state.pendingOrderBase, 2 ether);
        assertEq(state.targetHedgeBase, 0);
        assertEq(uint8(state.healthMode), uint8(ProductionDeltaNeutralHook.HealthMode.Defensive));
    }

    function test_nonManagerCannotMoveCollateral() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(ProductionDeltaNeutralHook.NotManager.selector);
        hook.withdrawCollateral(key, stranger, 1 ether);
    }

    function test_netDeltaInvariantEqualsPoolExposurePlusHedge() public {
        swap(key, true, -1 ether, ZERO_BYTES);
        hook.rebalance(key, 2_000 ether);
        hook.settleHedgeOrder(key);

        ProductionDeltaNeutralHook.StrategyRiskState memory state = hook.getRiskState(key);
        assertEq(hook.netBaseDelta(key), state.poolBaseExposure + state.hedgePositionBase);
    }

    function _configurePool() internal {
        hook.configurePool(
            key,
            ProductionDeltaNeutralHook.PoolConfigInput({
                baseIsCurrency0: true,
                minFeePips: MIN_FEE,
                targetFeePips: TARGET_FEE,
                maxFeePips: MAX_FEE,
                inventoryFeeBumpPips: BUMP,
                inventoryFeeDiscountPips: DISCOUNT,
                hedgeThresholdBase: THRESHOLD,
                maxResidualDeltaBase: MAX_RESIDUAL,
                maxPendingOrderAge: 1 hours,
                minCollateralRatioBps: 5_000,
                maxLeverageBps: 300_000,
                maxLossBps: 2_000
            })
        );
    }

    function _setAdapterSnapshot(
        int256 positionBase,
        int256 pendingOrderBase,
        uint256 collateralUsd,
        int256 realizedPnlUsd,
        int256 unrealizedPnlUsd,
        bool healthy
    ) internal {
        adapter.setSnapshot(
            IHedgeAdapter.HedgeSnapshot({
                positionBase: positionBase,
                pendingOrderBase: pendingOrderBase,
                realizedPnlUsd: realizedPnlUsd,
                unrealizedPnlUsd: unrealizedPnlUsd,
                collateralUsd: collateralUsd,
                lastPrice: 2_000 ether,
                pendingOrder: pendingOrderBase != 0,
                healthy: healthy
            })
        );
    }
}
