// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";

import {DemoERC20} from "../src/DemoERC20.sol";
import {ProductionDeltaNeutralHook} from "../src/ProductionDeltaNeutralHook.sol";
import {DemoHedgeAdapter} from "../src/adapters/DemoHedgeAdapter.sol";
import {IHedgeAdapter} from "../src/interfaces/IHedgeAdapter.sol";
import {IERC20Minimal} from "../src/interfaces/IERC20Minimal.sol";
import {HookAddressMiner} from "../src/libraries/HookAddressMiner.sol";
import {ProductionStrategyLiquidityRouter} from "../src/routers/ProductionStrategyLiquidityRouter.sol";

contract DeployProductionBaseSepolia is Script {
    using PoolIdLibrary for PoolKey;

    struct DemoContracts {
        DemoERC20 baseToken;
        DemoERC20 quoteToken;
        DemoERC20 collateral;
        DemoHedgeAdapter adapter;
        PoolSwapTest poolSwapTest;
        ProductionStrategyLiquidityRouter liquidityRouter;
        ProductionDeltaNeutralHook hook;
    }

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant BASE_SEPOLIA_POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;

    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    int24 internal constant TICK_SPACING = 60;

    uint24 internal constant MIN_FEE_PIPS = 100;
    uint24 internal constant TARGET_FEE_PIPS = 500;
    uint24 internal constant MAX_FEE_PIPS = 3_000;
    uint24 internal constant INVENTORY_FEE_BUMP_PIPS = 700;
    uint24 internal constant INVENTORY_FEE_DISCOUNT_PIPS = 200;

    uint256 internal constant HEDGE_THRESHOLD_BASE = 0.01 ether;
    uint256 internal constant MAX_RESIDUAL_DELTA_BASE = 0.005 ether;
    uint256 internal constant MAX_PENDING_ORDER_AGE = 1 hours;
    uint256 internal constant MAX_SNAPSHOT_AGE = 5 minutes;
    uint256 internal constant MIN_COLLATERAL_USD = 1_000 ether;
    uint256 internal constant MIN_COLLATERAL_RATIO_BPS = 5_000;
    uint256 internal constant MAX_LEVERAGE_BPS = 300_000;
    uint256 internal constant MAX_LOSS_BPS = 2_000;

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant FAUCET_AMOUNT = 1_000 ether;
    uint256 internal constant INITIAL_COLLATERAL = 100_000 ether;
    int256 internal constant INITIAL_LIQUIDITY = 1_000 ether;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG
        );

        vm.startBroadcast(deployerPrivateKey);

        DemoContracts memory deployed = _deployDemoContracts(deployer);
        deployed.hook = _deployHook(deployed, deployer, flags);
        deployed.adapter.setHook(address(deployed.hook));
        deployed.hook.setLiquidityManager(address(deployed.liquidityRouter), true);

        (PoolKey memory key, PoolId poolId, bool baseIsCurrency0) =
            _initializeAndConfigurePool(deployed);

        vm.stopBroadcast();

        _writeDeploymentJson(deployed, key, poolId, baseIsCurrency0);

        console.log("Production hook", address(deployed.hook));
        console.log("Demo hedge adapter", address(deployed.adapter));
        console.log("PoolSwapTest", address(deployed.poolSwapTest));
        console.log("Liquidity router", address(deployed.liquidityRouter));
        console.log("Collateral", address(deployed.collateral));
        console.logBytes32(PoolId.unwrap(poolId));
    }

    function _deployDemoContracts(address deployer) internal returns (DemoContracts memory deployed) {
        deployed.baseToken =
            new DemoERC20("Production Demo Wrapped Ether", "pdWETH", 18, INITIAL_SUPPLY, FAUCET_AMOUNT);
        deployed.quoteToken = new DemoERC20("Production Demo USD Coin", "pdUSDC", 18, INITIAL_SUPPLY, FAUCET_AMOUNT);
        deployed.collateral = new DemoERC20("Production Margin USDC", "pmUSDC", 18, INITIAL_SUPPLY, FAUCET_AMOUNT);
        deployed.adapter = new DemoHedgeAdapter(deployer, deployer);
        deployed.poolSwapTest = new PoolSwapTest(IPoolManager(BASE_SEPOLIA_POOL_MANAGER));
        deployed.liquidityRouter =
            new ProductionStrategyLiquidityRouter(IPoolManager(BASE_SEPOLIA_POOL_MANAGER), deployer);
    }

    function _deployHook(DemoContracts memory deployed, address deployer, uint160 flags)
        internal
        returns (ProductionDeltaNeutralHook hook)
    {
        bytes memory constructorArgs = abi.encode(
            IPoolManager(BASE_SEPOLIA_POOL_MANAGER),
            deployed.collateral,
            IHedgeAdapter(address(deployed.adapter)),
            deployer,
            deployer
        );
        (address expectedHookAddress, bytes32 salt) = HookAddressMiner.find(
            CREATE2_DEPLOYER, flags, type(ProductionDeltaNeutralHook).creationCode, constructorArgs
        );

        hook = new ProductionDeltaNeutralHook{salt: salt}(
            IPoolManager(BASE_SEPOLIA_POOL_MANAGER),
            IERC20Minimal(address(deployed.collateral)),
            IHedgeAdapter(address(deployed.adapter)),
            deployer,
            deployer
        );
        require(address(hook) == expectedHookAddress, "DeployProductionBaseSepolia: hook address mismatch");
    }

    function _sortCurrencies(address tokenA, address tokenB)
        internal
        pure
        returns (Currency currency0, Currency currency1)
    {
        require(tokenA != tokenB, "DeployProductionBaseSepolia: duplicate tokens");
        (address sorted0, address sorted1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return (Currency.wrap(sorted0), Currency.wrap(sorted1));
    }

    function _initializeAndConfigurePool(DemoContracts memory deployed)
        internal
        returns (PoolKey memory key, PoolId poolId, bool baseIsCurrency0)
    {
        (Currency currency0, Currency currency1) =
            _sortCurrencies(address(deployed.baseToken), address(deployed.quoteToken));
        baseIsCurrency0 = Currency.unwrap(currency0) == address(deployed.baseToken);
        key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(deployed.hook))
        });
        poolId = key.toId();

        IPoolManager(BASE_SEPOLIA_POOL_MANAGER).initialize(key, SQRT_PRICE_1_1);

        deployed.hook.configurePool(
            key,
            ProductionDeltaNeutralHook.PoolConfigInput({
                baseIsCurrency0: baseIsCurrency0,
                minFeePips: MIN_FEE_PIPS,
                targetFeePips: TARGET_FEE_PIPS,
                maxFeePips: MAX_FEE_PIPS,
                inventoryFeeBumpPips: INVENTORY_FEE_BUMP_PIPS,
                inventoryFeeDiscountPips: INVENTORY_FEE_DISCOUNT_PIPS,
                hedgeThresholdBase: HEDGE_THRESHOLD_BASE,
                maxResidualDeltaBase: MAX_RESIDUAL_DELTA_BASE,
                maxPendingOrderAge: MAX_PENDING_ORDER_AGE,
                maxSnapshotAge: MAX_SNAPSHOT_AGE,
                minCollateralUsd: MIN_COLLATERAL_USD,
                minCollateralRatioBps: MIN_COLLATERAL_RATIO_BPS,
                maxLeverageBps: MAX_LEVERAGE_BPS,
                maxLossBps: MAX_LOSS_BPS
            })
        );

        deployed.collateral.approve(address(deployed.hook), INITIAL_COLLATERAL);
        deployed.hook.depositCollateral(key, INITIAL_COLLATERAL);

        deployed.baseToken.approve(address(deployed.liquidityRouter), type(uint256).max);
        deployed.quoteToken.approve(address(deployed.liquidityRouter), type(uint256).max);
        deployed.baseToken.approve(address(deployed.poolSwapTest), type(uint256).max);
        deployed.quoteToken.approve(address(deployed.poolSwapTest), type(uint256).max);

        deployed.liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: INITIAL_LIQUIDITY, salt: 0}),
            ""
        );
    }

    function _writeDeploymentJson(
        DemoContracts memory deployed,
        PoolKey memory key,
        PoolId poolId,
        bool baseIsCurrency0
    ) internal {
        string memory object = "baseSepoliaProduction";
        string memory json = vm.serializeString(object, "network", "base-sepolia");
        json = vm.serializeBool(object, "isDeployed", true);
        json = vm.serializeUint(object, "chainId", 84_532);
        json = vm.serializeAddress(object, "poolManager", BASE_SEPOLIA_POOL_MANAGER);
        json = vm.serializeAddress(object, "hook", address(deployed.hook));
        json = vm.serializeAddress(object, "hedgeAdapter", address(deployed.adapter));
        json = vm.serializeString(object, "hedgeAdapterKind", "controlled-demo-synthetix-boundary");
        json = vm.serializeAddress(object, "poolSwapTest", address(deployed.poolSwapTest));
        json = vm.serializeAddress(object, "liquidityRouter", address(deployed.liquidityRouter));
        json = vm.serializeAddress(object, "collateralToken", address(deployed.collateral));
        json = vm.serializeAddress(object, "baseToken", address(deployed.baseToken));
        json = vm.serializeAddress(object, "quoteToken", address(deployed.quoteToken));
        json = vm.serializeAddress(object, "currency0", Currency.unwrap(key.currency0));
        json = vm.serializeAddress(object, "currency1", Currency.unwrap(key.currency1));
        json = vm.serializeUint(object, "fee", key.fee);
        json = vm.serializeInt(object, "tickSpacing", key.tickSpacing);
        json = vm.serializeAddress(object, "hooks", address(key.hooks));
        json = vm.serializeBytes32(object, "poolId", PoolId.unwrap(poolId));
        json = vm.serializeBool(object, "baseIsCurrency0", baseIsCurrency0);
        json = vm.serializeUint(object, "minFeePips", MIN_FEE_PIPS);
        json = vm.serializeUint(object, "targetFeePips", TARGET_FEE_PIPS);
        json = vm.serializeUint(object, "maxFeePips", MAX_FEE_PIPS);
        json = vm.serializeUint(object, "inventoryFeeBumpPips", INVENTORY_FEE_BUMP_PIPS);
        json = vm.serializeUint(object, "inventoryFeeDiscountPips", INVENTORY_FEE_DISCOUNT_PIPS);
        json = vm.serializeString(object, "hedgeThresholdBase", vm.toString(HEDGE_THRESHOLD_BASE));
        json = vm.serializeString(object, "maxResidualDeltaBase", vm.toString(MAX_RESIDUAL_DELTA_BASE));
        json = vm.serializeUint(object, "maxPendingOrderAge", MAX_PENDING_ORDER_AGE);
        json = vm.serializeUint(object, "maxSnapshotAge", MAX_SNAPSHOT_AGE);
        json = vm.serializeString(object, "minCollateralUsd", vm.toString(MIN_COLLATERAL_USD));
        json = vm.serializeUint(object, "minCollateralRatioBps", MIN_COLLATERAL_RATIO_BPS);
        json = vm.serializeUint(object, "maxLeverageBps", MAX_LEVERAGE_BPS);
        json = vm.serializeUint(object, "maxLossBps", MAX_LOSS_BPS);
        json = vm.serializeString(object, "initialCollateral", vm.toString(INITIAL_COLLATERAL));
        json = vm.serializeString(object, "initialLiquidity", vm.toString(INITIAL_LIQUIDITY));

        vm.createDir("deployments", true);
        vm.writeJson(json, "deployments/base-sepolia-production.json");

        vm.createDir("frontend/src/generated", true);
        vm.writeJson(json, "frontend/src/generated/base-sepolia-production.json");
    }
}
