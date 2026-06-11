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

import {DemoERC20} from "../src/DemoERC20.sol";
import {ProductionDeltaNeutralHook} from "../src/ProductionDeltaNeutralHook.sol";
import {MockHedgeAdapter} from "../src/adapters/MockHedgeAdapter.sol";
import {IHedgeAdapter} from "../src/interfaces/IHedgeAdapter.sol";
import {IERC20Minimal} from "../src/interfaces/IERC20Minimal.sol";
import {HookAddressMiner} from "../src/libraries/HookAddressMiner.sol";

contract DeployProductionBaseSepolia is Script {
    using PoolIdLibrary for PoolKey;

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
    uint256 internal constant MIN_COLLATERAL_RATIO_BPS = 5_000;
    uint256 internal constant MAX_LEVERAGE_BPS = 300_000;
    uint256 internal constant MAX_LOSS_BPS = 2_000;

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant FAUCET_AMOUNT = 1_000 ether;
    uint256 internal constant INITIAL_COLLATERAL = 100_000 ether;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );

        vm.startBroadcast(deployerPrivateKey);

        DemoERC20 baseToken =
            new DemoERC20("Production Demo Wrapped Ether", "pdWETH", 18, INITIAL_SUPPLY, FAUCET_AMOUNT);
        DemoERC20 quoteToken = new DemoERC20("Production Demo USD Coin", "pdUSDC", 18, INITIAL_SUPPLY, FAUCET_AMOUNT);
        DemoERC20 collateral = new DemoERC20("Production Margin USDC", "pmUSDC", 18, INITIAL_SUPPLY, FAUCET_AMOUNT);

        MockHedgeAdapter adapter = new MockHedgeAdapter();

        bytes memory constructorArgs = abi.encode(
            IPoolManager(BASE_SEPOLIA_POOL_MANAGER), collateral, IHedgeAdapter(address(adapter)), deployer, deployer
        );
        (address expectedHookAddress, bytes32 salt) = HookAddressMiner.find(
            CREATE2_DEPLOYER, flags, type(ProductionDeltaNeutralHook).creationCode, constructorArgs
        );

        ProductionDeltaNeutralHook hook = new ProductionDeltaNeutralHook{salt: salt}(
            IPoolManager(BASE_SEPOLIA_POOL_MANAGER),
            IERC20Minimal(address(collateral)),
            IHedgeAdapter(address(adapter)),
            deployer,
            deployer
        );
        require(address(hook) == expectedHookAddress, "DeployProductionBaseSepolia: hook address mismatch");

        adapter.setHook(address(hook));

        (PoolKey memory key, PoolId poolId, bool baseIsCurrency0) =
            _initializeAndConfigurePool(hook, baseToken, quoteToken, collateral);

        vm.stopBroadcast();

        _writeDeploymentJson(
            address(hook),
            address(adapter),
            address(collateral),
            address(baseToken),
            address(quoteToken),
            key,
            poolId,
            baseIsCurrency0
        );

        console.log("Production hook", address(hook));
        console.log("Mock hedge adapter", address(adapter));
        console.log("Collateral", address(collateral));
        console.logBytes32(PoolId.unwrap(poolId));
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

    function _initializeAndConfigurePool(
        ProductionDeltaNeutralHook hook,
        DemoERC20 baseToken,
        DemoERC20 quoteToken,
        DemoERC20 collateral
    ) internal returns (PoolKey memory key, PoolId poolId, bool baseIsCurrency0) {
        (Currency currency0, Currency currency1) = _sortCurrencies(address(baseToken), address(quoteToken));
        baseIsCurrency0 = Currency.unwrap(currency0) == address(baseToken);
        key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        IPoolManager(BASE_SEPOLIA_POOL_MANAGER).initialize(key, SQRT_PRICE_1_1);

        hook.configurePool(
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
                minCollateralRatioBps: MIN_COLLATERAL_RATIO_BPS,
                maxLeverageBps: MAX_LEVERAGE_BPS,
                maxLossBps: MAX_LOSS_BPS
            })
        );

        collateral.approve(address(hook), INITIAL_COLLATERAL);
        hook.depositCollateral(key, INITIAL_COLLATERAL);
    }

    function _writeDeploymentJson(
        address hook,
        address hedgeAdapter,
        address collateral,
        address baseToken,
        address quoteToken,
        PoolKey memory key,
        PoolId poolId,
        bool baseIsCurrency0
    ) internal {
        string memory object = "baseSepoliaProduction";
        string memory json = vm.serializeString(object, "network", "base-sepolia");
        json = vm.serializeBool(object, "isDeployed", true);
        json = vm.serializeUint(object, "chainId", 84_532);
        json = vm.serializeAddress(object, "poolManager", BASE_SEPOLIA_POOL_MANAGER);
        json = vm.serializeAddress(object, "hook", hook);
        json = vm.serializeAddress(object, "hedgeAdapter", hedgeAdapter);
        json = vm.serializeString(object, "hedgeAdapterKind", "mock-synthetix-boundary");
        json = vm.serializeAddress(object, "collateralToken", collateral);
        json = vm.serializeAddress(object, "baseToken", baseToken);
        json = vm.serializeAddress(object, "quoteToken", quoteToken);
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
        json = vm.serializeUint(object, "minCollateralRatioBps", MIN_COLLATERAL_RATIO_BPS);
        json = vm.serializeUint(object, "maxLeverageBps", MAX_LEVERAGE_BPS);
        json = vm.serializeUint(object, "maxLossBps", MAX_LOSS_BPS);
        json = vm.serializeString(object, "initialCollateral", vm.toString(INITIAL_COLLATERAL));

        vm.createDir("deployments", true);
        vm.writeJson(json, "deployments/base-sepolia-production.json");
    }
}
