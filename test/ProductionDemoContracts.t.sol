// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {DemoHedgeAdapter} from "../src/adapters/DemoHedgeAdapter.sol";
import {ProductionStrategyLiquidityRouter} from "../src/routers/ProductionStrategyLiquidityRouter.sol";

contract ProductionDemoContractsTest is Test, Deployers {
    DemoHedgeAdapter adapter;
    ProductionStrategyLiquidityRouter liquidityRouter;

    function setUp() public {
        deployFreshManager();
        adapter = new DemoHedgeAdapter(address(this), address(this));
        liquidityRouter = new ProductionStrategyLiquidityRouter(manager, address(this));
    }

    function test_demoAdapterScenarioControlsAreOperatorGated() public {
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(DemoHedgeAdapter.NotOperator.selector);
        adapter.setHealthy(bytes32(uint256(1)), false);
    }

    function test_demoAdapterProtocolCallsAreHookGated() public {
        adapter.setHook(makeAddr("hook"));

        vm.expectRevert(DemoHedgeAdapter.NotHook.selector);
        adapter.commitHedge(bytes32(uint256(1)), -1 ether, 2_000 ether);
    }

    function test_liquidityRouterCannotBeUsedByArbitraryCallers() public {
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(ProductionStrategyLiquidityRouter.NotOperator.selector);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1 ether, salt: 0}), ZERO_BYTES
        );
    }
}
