// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

/// @notice Inventory-aware Uniswap v4 hook for a hybrid delta-neutral market maker.
/// @dev The hook owns risk accounting and fee policy. External hedge execution is reported by keepers.
contract DeltaNeutralHook is IHooks {
    using BalanceDeltaLibrary for BalanceDelta;
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;

    struct PoolConfigInput {
        bool baseIsCurrency0;
        uint24 minFeePips;
        uint24 targetFeePips;
        uint24 maxFeePips;
        uint24 inventoryFeeBumpPips;
        uint24 inventoryFeeDiscountPips;
        uint256 maxPriceAge;
        uint256 hedgeThresholdBase;
        uint256 maxUnhedgedBase;
    }

    struct PoolConfig {
        bool configured;
        bool baseIsCurrency0;
        uint24 minFeePips;
        uint24 targetFeePips;
        uint24 maxFeePips;
        uint24 inventoryFeeBumpPips;
        uint24 inventoryFeeDiscountPips;
        uint256 maxPriceAge;
        uint256 hedgeThresholdBase;
        uint256 maxUnhedgedBase;
    }

    struct PoolRiskState {
        int256 poolBaseExposure;
        int256 reportedHedgeBase;
        int256 pendingHedgeBase;
        uint256 lastReferencePriceX96;
        uint256 lastReferenceTimestamp;
        uint256 hedgeNonce;
        bool paused;
    }

    IPoolManager public immutable poolManager;
    address public owner;

    mapping(PoolId poolId => PoolConfig config) public poolConfigs;
    mapping(PoolId poolId => PoolRiskState state) public poolRiskStates;
    mapping(address account => bool allowed) public keepers;
    mapping(address account => bool allowed) public priceUpdaters;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event KeeperUpdated(address indexed keeper, bool allowed);
    event PriceUpdaterUpdated(address indexed updater, bool allowed);
    event PoolConfigured(bytes32 indexed poolId, bool baseIsCurrency0, uint24 targetFeePips);
    event PoolPaused(bytes32 indexed poolId, bool paused);
    event ReferencePriceUpdated(bytes32 indexed poolId, uint256 referencePriceX96, uint256 timestamp);
    event RiskStateUpdated(
        bytes32 indexed poolId,
        int256 poolBaseExposure,
        int256 reportedHedgeBase,
        int256 pendingHedgeBase,
        int256 netBaseDelta
    );
    event FeeUpdated(bytes32 indexed poolId, uint24 feePips, bool exposureIncreasing);
    event HedgeIntent(
        bytes32 indexed poolId,
        uint256 indexed nonce,
        int256 netBaseDelta,
        int256 hedgeBaseDelta,
        uint256 referencePriceX96
    );
    event HedgeFillRecorded(
        bytes32 indexed poolId, uint256 indexed nonce, int256 hedgeBaseDelta, int256 reportedHedgeBase
    );

    error NotOwner();
    error NotKeeper();
    error NotPriceUpdater();
    error NotPoolManager();
    error MustUseDynamicFee();
    error PoolNotConfigured();
    error InvalidFeeConfig();
    error InvalidRiskConfig();
    error InvalidReferencePrice();
    error PriceStale();
    error PoolIsPaused();
    error UnhedgedExposureTooLarge(int256 netBaseDelta, uint256 maxUnhedgedBase);
    error NoPendingHedge();
    error InvalidHedgeNonce(uint256 expected, uint256 actual);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (!keepers[msg.sender]) revert NotKeeper();
        _;
    }

    modifier onlyPriceUpdater() {
        if (!priceUpdaters[msg.sender]) revert NotPriceUpdater();
        _;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _poolManager, address initialOwner) {
        require(initialOwner != address(0), "owner is zero");
        poolManager = _poolManager;
        owner = initialOwner;
        keepers[initialOwner] = true;
        priceUpdaters[initialOwner] = true;

        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());

        emit OwnerTransferred(address(0), initialOwner);
        emit KeeperUpdated(initialOwner, true);
        emit PriceUpdaterUpdated(initialOwner, true);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "new owner is zero");
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function setPriceUpdater(address updater, bool allowed) external onlyOwner {
        priceUpdaters[updater] = allowed;
        emit PriceUpdaterUpdated(updater, allowed);
    }

    function configurePool(PoolKey calldata key, PoolConfigInput calldata input) external onlyOwner {
        if (input.minFeePips > input.targetFeePips || input.targetFeePips > input.maxFeePips) {
            revert InvalidFeeConfig();
        }
        if (!input.maxFeePips.isValid()) revert InvalidFeeConfig();
        if (input.hedgeThresholdBase == 0 || input.maxUnhedgedBase < input.hedgeThresholdBase) {
            revert InvalidRiskConfig();
        }

        PoolId poolId = key.toId();
        poolConfigs[poolId] = PoolConfig({
            configured: true,
            baseIsCurrency0: input.baseIsCurrency0,
            minFeePips: input.minFeePips,
            targetFeePips: input.targetFeePips,
            maxFeePips: input.maxFeePips,
            inventoryFeeBumpPips: input.inventoryFeeBumpPips,
            inventoryFeeDiscountPips: input.inventoryFeeDiscountPips,
            maxPriceAge: input.maxPriceAge,
            hedgeThresholdBase: input.hedgeThresholdBase,
            maxUnhedgedBase: input.maxUnhedgedBase
        });

        emit PoolConfigured(PoolId.unwrap(poolId), input.baseIsCurrency0, input.targetFeePips);
    }

    function setPoolPaused(PoolKey calldata key, bool paused) external onlyOwner {
        PoolId poolId = key.toId();
        _requireConfigured(poolId);
        poolRiskStates[poolId].paused = paused;
        emit PoolPaused(PoolId.unwrap(poolId), paused);
    }

    function updateReferencePrice(PoolKey calldata key, uint256 referencePriceX96) external onlyPriceUpdater {
        if (referencePriceX96 == 0) revert InvalidReferencePrice();

        PoolId poolId = key.toId();
        _requireConfigured(poolId);

        PoolRiskState storage state = poolRiskStates[poolId];
        state.lastReferencePriceX96 = referencePriceX96;
        state.lastReferenceTimestamp = block.timestamp;

        emit ReferencePriceUpdated(PoolId.unwrap(poolId), referencePriceX96, block.timestamp);
    }

    function recordHedgeFill(PoolKey calldata key, uint256 nonce, int256 hedgeBaseDelta) external onlyKeeper {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        PoolRiskState storage state = poolRiskStates[poolId];

        if (state.pendingHedgeBase == 0) revert NoPendingHedge();
        if (nonce != state.hedgeNonce) revert InvalidHedgeNonce(state.hedgeNonce, nonce);

        state.reportedHedgeBase += hedgeBaseDelta;
        emit HedgeFillRecorded(PoolId.unwrap(poolId), nonce, hedgeBaseDelta, state.reportedHedgeBase);

        _syncHedgeIntent(poolId, config, state);
        _emitRiskState(poolId, state);
    }

    function getRiskState(PoolKey calldata key) external view returns (PoolRiskState memory) {
        return poolRiskStates[key.toId()];
    }

    function netBaseDelta(PoolKey calldata key) external view returns (int256) {
        PoolRiskState storage state = poolRiskStates[key.toId()];
        return state.poolBaseExposure + state.reportedHedgeBase;
    }

    function previewFee(PoolKey calldata key, SwapParams calldata params) external view returns (uint24 feePips) {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        PoolRiskState storage state = poolRiskStates[poolId];
        return _computeFee(config, state, params.zeroForOne);
    }

    function beforeInitialize(address, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (!key.fee.isDynamicFee()) revert MustUseDynamicFee();
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external view onlyPoolManager returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        PoolRiskState storage state = poolRiskStates[poolId];

        uint24 feePips = _computeFee(config, state, params.zeroForOne);
        bool exposureIncreasing = _increasesExposure(
            state.poolBaseExposure + state.reportedHedgeBase,
            _poolBaseExposureDirection(config, params.zeroForOne)
        );

        emit FeeUpdated(PoolId.unwrap(poolId), feePips, exposureIncreasing);

        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            feePips | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        PoolRiskState storage state = poolRiskStates[poolId];

        int128 baseCallerDelta = config.baseIsCurrency0 ? delta.amount0() : delta.amount1();
        state.poolBaseExposure -= int256(baseCallerDelta);

        _syncHedgeIntent(poolId, config, state);
        _emitRiskState(poolId, state);

        return (IHooks.afterSwap.selector, 0);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        return IHooks.afterDonate.selector;
    }

    function _requireConfigured(PoolId poolId) internal view returns (PoolConfig storage config) {
        config = poolConfigs[poolId];
        if (!config.configured) revert PoolNotConfigured();
    }

    function _computeFee(PoolConfig storage config, PoolRiskState storage state, bool zeroForOne)
        internal
        view
        returns (uint24)
    {
        if (state.paused) revert PoolIsPaused();
        if (state.lastReferencePriceX96 == 0) revert PriceStale();
        if (config.maxPriceAge != 0 && block.timestamp > state.lastReferenceTimestamp + config.maxPriceAge) {
            revert PriceStale();
        }

        int256 netDelta = state.poolBaseExposure + state.reportedHedgeBase;
        int256 direction = _poolBaseExposureDirection(config, zeroForOne);
        bool exposureIncreasing = _increasesExposure(netDelta, direction);

        if (config.maxUnhedgedBase != 0 && _abs(netDelta) > config.maxUnhedgedBase && exposureIncreasing) {
            revert UnhedgedExposureTooLarge(netDelta, config.maxUnhedgedBase);
        }

        uint24 fee = config.targetFeePips;
        if (netDelta != 0) {
            if (exposureIncreasing) {
                fee = _addCapped(fee, config.inventoryFeeBumpPips, config.maxFeePips);
            } else {
                fee = _subtractFloored(fee, config.inventoryFeeDiscountPips, config.minFeePips);
            }
        }

        return _clamp(fee, config.minFeePips, config.maxFeePips);
    }

    function _syncHedgeIntent(PoolId poolId, PoolConfig storage config, PoolRiskState storage state) internal {
        int256 netDelta = state.poolBaseExposure + state.reportedHedgeBase;
        int256 desiredHedgeDelta = _abs(netDelta) >= config.hedgeThresholdBase ? -netDelta : int256(0);

        if (desiredHedgeDelta == state.pendingHedgeBase) return;

        state.pendingHedgeBase = desiredHedgeDelta;
        if (desiredHedgeDelta != 0) {
            unchecked {
                ++state.hedgeNonce;
            }
            emit HedgeIntent(
                PoolId.unwrap(poolId),
                state.hedgeNonce,
                netDelta,
                desiredHedgeDelta,
                state.lastReferencePriceX96
            );
        }
    }

    function _emitRiskState(PoolId poolId, PoolRiskState storage state) internal {
        emit RiskStateUpdated(
            PoolId.unwrap(poolId),
            state.poolBaseExposure,
            state.reportedHedgeBase,
            state.pendingHedgeBase,
            state.poolBaseExposure + state.reportedHedgeBase
        );
    }

    function _poolBaseExposureDirection(PoolConfig storage config, bool zeroForOne)
        internal
        view
        returns (int256)
    {
        return zeroForOne == config.baseIsCurrency0 ? int256(1) : int256(-1);
    }

    function _increasesExposure(int256 netDelta, int256 direction) internal pure returns (bool) {
        if (netDelta == 0) return false;
        return (netDelta > 0 && direction > 0) || (netDelta < 0 && direction < 0);
    }

    function _addCapped(uint24 value, uint24 amount, uint24 cap) internal pure returns (uint24) {
        uint256 result = uint256(value) + amount;
        return result > cap ? cap : uint24(result);
    }

    function _subtractFloored(uint24 value, uint24 amount, uint24 floor) internal pure returns (uint24) {
        if (amount >= value) return floor;
        uint24 result = value - amount;
        return result < floor ? floor : result;
    }

    function _clamp(uint24 value, uint24 floor, uint24 cap) internal pure returns (uint24) {
        if (value < floor) return floor;
        if (value > cap) return cap;
        return value;
    }

    function _abs(int256 value) internal pure returns (uint256) {
        return value < 0 ? uint256(-value) : uint256(value);
    }
}
