// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {DeltaNeutralHook} from "../src/DeltaNeutralHook.sol";

contract DeltaNeutralHookTest is Test, Deployers {
    DeltaNeutralHook hook;

    uint24 internal constant MIN_FEE = 100;
    uint24 internal constant TARGET_FEE = 500;
    uint24 internal constant MAX_FEE = 3_000;
    uint24 internal constant BUMP = 700;
    uint24 internal constant DISCOUNT = 200;
    uint256 internal constant REFERENCE_PRICE_X96 = 2_000 << 96;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        deployCodeTo("DeltaNeutralHook.sol", abi.encode(manager, address(this)), address(flags));
        hook = DeltaNeutralHook(address(flags));

        (key,) = initPool(currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);

        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1_000 ether, salt: 0}),
            ZERO_BYTES
        );

        _configurePool(0.01 ether, 100 ether);
        hook.updateReferencePrice(key, REFERENCE_PRICE_X96);
    }

    function test_requiresDynamicFeePool() public {
        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        deployCodeTo("DeltaNeutralHook.sol", abi.encode(manager, address(this)), address(flags));
        DeltaNeutralHook otherHook = DeltaNeutralHook(address(flags));

        vm.expectRevert();
        initPool(currency0, currency1, IHooks(address(otherHook)), 500, SQRT_PRICE_1_1);
    }

    function test_previewFeeStartsAtTargetFee() public view {
        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});

        assertEq(hook.previewFee(key, params), TARGET_FEE);
    }

    function test_afterSwapUpdatesExposureAndHedgeIntent() public {
        swap(key, true, -1 ether, ZERO_BYTES);

        DeltaNeutralHook.PoolRiskState memory state = hook.getRiskState(key);
        assertGt(state.poolBaseExposure, 0, "zeroForOne should increase currency0/base exposure");
        assertLt(state.pendingHedgeBase, 0, "positive base exposure should request a short hedge");
        assertEq(state.pendingHedgeBase, -state.poolBaseExposure);
        assertEq(state.hedgeNonce, 1);
    }

    function test_feePenalizesExposureIncreasingFlowAndDiscountsReducingFlow() public {
        swap(key, true, -1 ether, ZERO_BYTES);

        SwapParams memory increaseExposure =
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});
        SwapParams memory reduceExposure =
            SwapParams({zeroForOne: false, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1});

        assertEq(hook.previewFee(key, increaseExposure), TARGET_FEE + BUMP);
        assertEq(hook.previewFee(key, reduceExposure), TARGET_FEE - DISCOUNT);
    }

    function test_recordHedgeFillNeutralizesPendingDelta() public {
        swap(key, true, -1 ether, ZERO_BYTES);

        DeltaNeutralHook.PoolRiskState memory beforeFill = hook.getRiskState(key);
        hook.recordHedgeFill(key, beforeFill.hedgeNonce, beforeFill.pendingHedgeBase);

        DeltaNeutralHook.PoolRiskState memory afterFill = hook.getRiskState(key);
        assertEq(afterFill.pendingHedgeBase, 0);
        assertEq(afterFill.reportedHedgeBase, beforeFill.pendingHedgeBase);
        assertEq(afterFill.poolBaseExposure + afterFill.reportedHedgeBase, 0);
    }

    function test_staleReferencePriceRevertsPreview() public {
        vm.warp(block.timestamp + 2 days);

        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});

        vm.expectRevert(DeltaNeutralHook.PriceStale.selector);
        hook.previewFee(key, params);
    }

    function test_pausedPoolRevertsPreview() public {
        hook.setPoolPaused(key, true);

        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});

        vm.expectRevert(DeltaNeutralHook.PoolIsPaused.selector);
        hook.previewFee(key, params);
    }

    function test_maxUnhedgedExposureBlocksOnlyIncreasingFlow() public {
        _configurePool(0.01 ether, 0.02 ether);
        hook.updateReferencePrice(key, REFERENCE_PRICE_X96);

        swap(key, true, -1 ether, ZERO_BYTES);

        SwapParams memory increaseExposure =
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});
        SwapParams memory reduceExposure =
            SwapParams({zeroForOne: false, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1});

        vm.expectRevert();
        hook.previewFee(key, increaseExposure);

        assertEq(hook.previewFee(key, reduceExposure), TARGET_FEE - DISCOUNT);
    }

    function test_nonKeeperCannotRecordHedgeFill() public {
        swap(key, true, -1 ether, ZERO_BYTES);
        DeltaNeutralHook.PoolRiskState memory state = hook.getRiskState(key);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(DeltaNeutralHook.NotKeeper.selector);
        hook.recordHedgeFill(key, state.hedgeNonce, state.pendingHedgeBase);
    }

    function test_nonPriceUpdaterCannotPostReferencePrice() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(DeltaNeutralHook.NotPriceUpdater.selector);
        hook.updateReferencePrice(key, REFERENCE_PRICE_X96);
    }

    function _configurePool(uint256 hedgeThresholdBase, uint256 maxUnhedgedBase) internal {
        hook.configurePool(
            key,
            DeltaNeutralHook.PoolConfigInput({
                baseIsCurrency0: true,
                minFeePips: MIN_FEE,
                targetFeePips: TARGET_FEE,
                maxFeePips: MAX_FEE,
                inventoryFeeBumpPips: BUMP,
                inventoryFeeDiscountPips: DISCOUNT,
                maxPriceAge: 1 days,
                hedgeThresholdBase: hedgeThresholdBase,
                maxUnhedgedBase: maxUnhedgedBase
            })
        );
    }
}
