// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";

import {DeltaNeutralHook} from "../src/DeltaNeutralHook.sol";
import {DemoERC20} from "../src/DemoERC20.sol";
import {HookAddressMiner} from "../src/libraries/HookAddressMiner.sol";

contract DeploySepolia is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    address internal constant SEPOLIA_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant SEPOLIA_POOL_SWAP_TEST = 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe;
    address internal constant SEPOLIA_POOL_MODIFY_LIQUIDITY_TEST = 0x0C478023803a644c94c4CE1C1e7b9A087e411B0A;

    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    int24 internal constant TICK_SPACING = 60;

    uint24 internal constant MIN_FEE_PIPS = 100;
    uint24 internal constant TARGET_FEE_PIPS = 500;
    uint24 internal constant MAX_FEE_PIPS = 3_000;
    uint24 internal constant INVENTORY_FEE_BUMP_PIPS = 700;
    uint24 internal constant INVENTORY_FEE_DISCOUNT_PIPS = 200;
    uint256 internal constant MAX_PRICE_AGE = 1 days;
    uint256 internal constant HEDGE_THRESHOLD_BASE = 0.01 ether;
    uint256 internal constant MAX_UNHEDGED_BASE = 100 ether;
    uint256 internal constant INITIAL_REFERENCE_PRICE_X96 = 2_000 << 96;

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant FAUCET_AMOUNT = 1_000 ether;
    int256 internal constant INITIAL_LIQUIDITY = 1_000 ether;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(IPoolManager(SEPOLIA_POOL_MANAGER), deployer);
        (address expectedHookAddress, bytes32 salt) =
            HookAddressMiner.find(CREATE2_DEPLOYER, flags, type(DeltaNeutralHook).creationCode, constructorArgs);

        console.log("Deployer", deployer);
        console.log("Expected hook", expectedHookAddress);

        vm.startBroadcast(deployerPrivateKey);

        DeltaNeutralHook hook = new DeltaNeutralHook{salt: salt}(IPoolManager(SEPOLIA_POOL_MANAGER), deployer);
        require(address(hook) == expectedHookAddress, "DeploySepolia: hook address mismatch");

        DemoERC20 weth = new DemoERC20("Demo Wrapped Ether", "dWETH", 18, INITIAL_SUPPLY, FAUCET_AMOUNT);
        DemoERC20 usdc = new DemoERC20("Demo USD Coin", "dUSDC", 18, INITIAL_SUPPLY, FAUCET_AMOUNT);

        weth.approve(SEPOLIA_POOL_MODIFY_LIQUIDITY_TEST, type(uint256).max);
        usdc.approve(SEPOLIA_POOL_MODIFY_LIQUIDITY_TEST, type(uint256).max);
        weth.approve(SEPOLIA_POOL_SWAP_TEST, type(uint256).max);
        usdc.approve(SEPOLIA_POOL_SWAP_TEST, type(uint256).max);

        (Currency currency0, Currency currency1) = _sortCurrencies(address(weth), address(usdc));
        bool baseIsCurrency0 = Currency.unwrap(currency0) == address(weth);
        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        PoolId poolId = key.toId();

        IPoolManager(SEPOLIA_POOL_MANAGER).initialize(key, SQRT_PRICE_1_1);

        hook.configurePool(
            key,
            DeltaNeutralHook.PoolConfigInput({
                baseIsCurrency0: baseIsCurrency0,
                minFeePips: MIN_FEE_PIPS,
                targetFeePips: TARGET_FEE_PIPS,
                maxFeePips: MAX_FEE_PIPS,
                inventoryFeeBumpPips: INVENTORY_FEE_BUMP_PIPS,
                inventoryFeeDiscountPips: INVENTORY_FEE_DISCOUNT_PIPS,
                maxPriceAge: MAX_PRICE_AGE,
                hedgeThresholdBase: HEDGE_THRESHOLD_BASE,
                maxUnhedgedBase: MAX_UNHEDGED_BASE
            })
        );
        hook.updateReferencePrice(key, INITIAL_REFERENCE_PRICE_X96);

        PoolModifyLiquidityTest(SEPOLIA_POOL_MODIFY_LIQUIDITY_TEST).modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: INITIAL_LIQUIDITY, salt: 0}),
            ""
        );

        vm.stopBroadcast();

        _writeDeploymentJson(address(hook), address(weth), address(usdc), key, poolId, baseIsCurrency0);

        console.log("Hook", address(hook));
        console.log("dWETH", address(weth));
        console.log("dUSDC", address(usdc));
        console.logBytes32(PoolId.unwrap(poolId));
    }

    function _sortCurrencies(address tokenA, address tokenB) internal pure returns (Currency currency0, Currency currency1) {
        require(tokenA != tokenB, "DeploySepolia: duplicate tokens");
        (address sorted0, address sorted1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return (Currency.wrap(sorted0), Currency.wrap(sorted1));
    }

    function _writeDeploymentJson(
        address hook,
        address baseToken,
        address quoteToken,
        PoolKey memory key,
        PoolId poolId,
        bool baseIsCurrency0
    ) internal {
        string memory object = "sepolia";
        string memory json = vm.serializeString(object, "network", "sepolia");
        json = vm.serializeBool(object, "isDeployed", true);
        json = vm.serializeUint(object, "chainId", 11_155_111);
        json = vm.serializeAddress(object, "poolManager", SEPOLIA_POOL_MANAGER);
        json = vm.serializeAddress(object, "poolSwapTest", SEPOLIA_POOL_SWAP_TEST);
        json = vm.serializeAddress(object, "poolModifyLiquidityTest", SEPOLIA_POOL_MODIFY_LIQUIDITY_TEST);
        json = vm.serializeAddress(object, "hook", hook);
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
        json = vm.serializeUint(object, "maxPriceAge", MAX_PRICE_AGE);
        json = vm.serializeString(object, "hedgeThresholdBase", vm.toString(HEDGE_THRESHOLD_BASE));
        json = vm.serializeString(object, "maxUnhedgedBase", vm.toString(MAX_UNHEDGED_BASE));
        json = vm.serializeString(object, "initialReferencePriceX96", vm.toString(INITIAL_REFERENCE_PRICE_X96));
        json = vm.serializeString(object, "initialLiquidity", vm.toString(INITIAL_LIQUIDITY));

        vm.createDir("deployments", true);
        vm.writeJson(json, "deployments/sepolia.json");

        vm.createDir("frontend/src/generated", true);
        vm.writeJson(json, "frontend/src/generated/sepolia.json");
    }
}
