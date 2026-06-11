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

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IHedgeAdapter} from "./interfaces/IHedgeAdapter.sol";

/// @notice Production-oriented delta-neutral v4 hook with collateral custody and async hedge lifecycle.
/// @dev The hook owns risk policy. The adapter owns venue-specific hedge mechanics.
contract ProductionDeltaNeutralHook is IHooks {
    using BalanceDeltaLibrary for BalanceDelta;
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;

    enum HealthMode {
        Healthy,
        NeedsRebalance,
        PendingOrder,
        Defensive,
        Paused
    }

    struct PoolConfigInput {
        bool baseIsCurrency0;
        uint24 minFeePips;
        uint24 targetFeePips;
        uint24 maxFeePips;
        uint24 inventoryFeeBumpPips;
        uint24 inventoryFeeDiscountPips;
        uint256 hedgeThresholdBase;
        uint256 maxResidualDeltaBase;
        uint256 maxPendingOrderAge;
        uint256 minCollateralRatioBps;
        uint256 maxLeverageBps;
        uint256 maxLossBps;
    }

    struct PoolConfig {
        bool configured;
        bool baseIsCurrency0;
        uint24 minFeePips;
        uint24 targetFeePips;
        uint24 maxFeePips;
        uint24 inventoryFeeBumpPips;
        uint24 inventoryFeeDiscountPips;
        uint256 hedgeThresholdBase;
        uint256 maxResidualDeltaBase;
        uint256 maxPendingOrderAge;
        uint256 minCollateralRatioBps;
        uint256 maxLeverageBps;
        uint256 maxLossBps;
    }

    struct StrategyRiskState {
        int256 poolBaseExposure;
        int256 hedgePositionBase;
        int256 targetHedgeBase;
        int256 pendingOrderBase;
        int256 netBaseDelta;
        int256 realizedPnlUsd;
        int256 unrealizedPnlUsd;
        uint256 collateralUsd;
        uint256 initialCollateralUsd;
        uint256 lastHedgePrice;
        uint256 lastRebalanceTimestamp;
        bytes32 pendingOrderId;
        HealthMode healthMode;
    }

    IPoolManager public immutable poolManager;
    IERC20Minimal public immutable collateralToken;
    IHedgeAdapter public hedgeAdapter;
    address public owner;
    address public strategyManager;
    bool internal locked;

    mapping(PoolId poolId => PoolConfig config) public poolConfigs;
    mapping(PoolId poolId => StrategyRiskState state) public riskStates;
    mapping(address account => bool allowed) public keepers;
    mapping(address account => bool allowed) public liquidityManagers;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event StrategyManagerUpdated(address indexed manager);
    event KeeperUpdated(address indexed keeper, bool allowed);
    event LiquidityManagerUpdated(address indexed manager, bool allowed);
    event PoolConfigured(bytes32 indexed poolId, bool baseIsCurrency0, uint24 targetFeePips);
    event PoolPaused(bytes32 indexed poolId, bool paused);
    event CollateralDeposited(uint256 amount, uint256 collateralUsd);
    event CollateralWithdrawn(address indexed to, uint256 amount, uint256 collateralUsd);
    event RiskStateSynced(
        bytes32 indexed poolId,
        int256 poolBaseExposure,
        int256 hedgePositionBase,
        int256 netBaseDelta,
        int256 realizedPnlUsd,
        int256 unrealizedPnlUsd,
        uint256 collateralUsd,
        HealthMode healthMode
    );
    event RebalanceNeeded(
        bytes32 indexed poolId,
        int256 netBaseDelta,
        int256 targetHedgeBase,
        int256 hedgeDeltaBase,
        HealthMode healthMode
    );
    event HedgeOrderCommitted(bytes32 indexed poolId, bytes32 indexed orderId, int256 hedgeDeltaBase);
    event HedgeOrderSettled(
        bytes32 indexed poolId, bytes32 indexed orderId, int256 hedgePositionBase, int256 netBaseDelta
    );
    event EmergencyDeRiskRequested(bytes32 indexed poolId, bytes32 indexed orderId, int256 hedgeDeltaBase);
    event FeeUpdated(bytes32 indexed poolId, uint24 feePips, bool exposureIncreasing, HealthMode healthMode);

    error NotOwner();
    error NotManager();
    error NotKeeper();
    error NotPoolManager();
    error NotLiquidityManager();
    error MustUseDynamicFee();
    error PoolNotConfigured();
    error InvalidFeeConfig();
    error InvalidRiskConfig();
    error InvalidAddress();
    error PoolIsPaused();
    error PendingOrderExists(bytes32 orderId);
    error NoPendingOrder();
    error NoRebalanceNeeded();
    error InsufficientCollateral(uint256 collateralUsd, uint256 requiredUsd);
    error MaxLossExceeded(int256 pnlUsd, uint256 maxLossUsd);
    error HedgeAdapterUnhealthy();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyManager() {
        if (msg.sender != owner && msg.sender != strategyManager) revert NotManager();
        _;
    }

    modifier onlyKeeperOrManager() {
        if (msg.sender != owner && msg.sender != strategyManager && !keepers[msg.sender]) revert NotKeeper();
        _;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    constructor(
        IPoolManager _poolManager,
        IERC20Minimal _collateralToken,
        IHedgeAdapter _hedgeAdapter,
        address initialOwner,
        address initialStrategyManager
    ) {
        if (
            address(_poolManager) == address(0) || address(_collateralToken) == address(0)
                || address(_hedgeAdapter) == address(0) || initialOwner == address(0)
                || initialStrategyManager == address(0)
        ) revert InvalidAddress();

        poolManager = _poolManager;
        collateralToken = _collateralToken;
        hedgeAdapter = _hedgeAdapter;
        owner = initialOwner;
        strategyManager = initialStrategyManager;
        keepers[initialOwner] = true;
        keepers[initialStrategyManager] = true;
        liquidityManagers[initialStrategyManager] = true;

        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());

        emit OwnerTransferred(address(0), initialOwner);
        emit StrategyManagerUpdated(initialStrategyManager);
        emit KeeperUpdated(initialOwner, true);
        emit KeeperUpdated(initialStrategyManager, true);
        emit LiquidityManagerUpdated(initialStrategyManager, true);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
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
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setStrategyManager(address newManager) external onlyOwner {
        if (newManager == address(0)) revert InvalidAddress();
        strategyManager = newManager;
        liquidityManagers[newManager] = true;
        keepers[newManager] = true;
        emit StrategyManagerUpdated(newManager);
        emit LiquidityManagerUpdated(newManager, true);
        emit KeeperUpdated(newManager, true);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function setLiquidityManager(address manager, bool allowed) external onlyOwner {
        liquidityManagers[manager] = allowed;
        emit LiquidityManagerUpdated(manager, allowed);
    }

    function setHedgeAdapter(IHedgeAdapter newAdapter) external onlyOwner {
        if (address(newAdapter) == address(0)) revert InvalidAddress();
        hedgeAdapter = newAdapter;
    }

    function configurePool(PoolKey calldata key, PoolConfigInput calldata input) external onlyOwner {
        if (input.minFeePips > input.targetFeePips || input.targetFeePips > input.maxFeePips) {
            revert InvalidFeeConfig();
        }
        if (!input.maxFeePips.isValid()) revert InvalidFeeConfig();
        if (
            input.hedgeThresholdBase == 0 || input.maxResidualDeltaBase > input.hedgeThresholdBase
                || input.minCollateralRatioBps == 0 || input.maxLeverageBps == 0 || input.maxLossBps > 10_000
        ) revert InvalidRiskConfig();

        PoolId poolId = key.toId();
        poolConfigs[poolId] = PoolConfig({
            configured: true,
            baseIsCurrency0: input.baseIsCurrency0,
            minFeePips: input.minFeePips,
            targetFeePips: input.targetFeePips,
            maxFeePips: input.maxFeePips,
            inventoryFeeBumpPips: input.inventoryFeeBumpPips,
            inventoryFeeDiscountPips: input.inventoryFeeDiscountPips,
            hedgeThresholdBase: input.hedgeThresholdBase,
            maxResidualDeltaBase: input.maxResidualDeltaBase,
            maxPendingOrderAge: input.maxPendingOrderAge,
            minCollateralRatioBps: input.minCollateralRatioBps,
            maxLeverageBps: input.maxLeverageBps,
            maxLossBps: input.maxLossBps
        });

        riskStates[poolId].healthMode = HealthMode.Healthy;
        emit PoolConfigured(PoolId.unwrap(poolId), input.baseIsCurrency0, input.targetFeePips);
    }

    function setPoolPaused(PoolKey calldata key, bool paused) external onlyManager {
        PoolId poolId = key.toId();
        _requireConfigured(poolId);
        riskStates[poolId].healthMode = paused ? HealthMode.Paused : HealthMode.Healthy;
        emit PoolPaused(PoolId.unwrap(poolId), paused);
    }

    function depositCollateral(PoolKey calldata key, uint256 amount) external onlyManager nonReentrant {
        require(amount > 0, "amount is zero");
        PoolId poolId = key.toId();
        _requireConfigured(poolId);

        collateralToken.transferFrom(msg.sender, address(this), amount);
        collateralToken.approve(address(hedgeAdapter), amount);
        uint256 collateralUsd = hedgeAdapter.depositCollateral(address(collateralToken), amount);
        StrategyRiskState storage state = riskStates[poolId];
        state.collateralUsd = collateralUsd;
        if (state.initialCollateralUsd == 0 || collateralUsd > state.initialCollateralUsd) {
            state.initialCollateralUsd = collateralUsd;
        }
        emit CollateralDeposited(amount, collateralUsd);
    }

    function withdrawCollateral(PoolKey calldata key, address to, uint256 amount) external onlyManager nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        StrategyRiskState storage state = riskStates[poolId];
        _refreshSnapshot(poolId, state);
        _requireHealthyCollateral(config, state, 0);

        uint256 collateralUsd = hedgeAdapter.withdrawCollateral(address(collateralToken), to, amount);
        state.collateralUsd = collateralUsd;
        _applyHealth(config, state);
        emit CollateralWithdrawn(to, amount, collateralUsd);
    }

    function rebalance(PoolKey calldata key, uint256 acceptablePrice)
        external
        onlyKeeperOrManager
        nonReentrant
        returns (bytes32 orderId)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        StrategyRiskState storage state = riskStates[poolId];
        _refreshSnapshot(poolId, state);

        if (state.pendingOrderId != bytes32(0) || state.pendingOrderBase != 0) {
            revert PendingOrderExists(state.pendingOrderId);
        }

        int256 hedgeDeltaBase = _requiredHedgeDelta(config, state);
        if (hedgeDeltaBase == 0) revert NoRebalanceNeeded();
        _requireHealthyCollateral(config, state, hedgeDeltaBase);

        orderId = hedgeAdapter.commitHedge(hedgeDeltaBase, acceptablePrice);
        state.pendingOrderId = orderId;
        state.pendingOrderBase = hedgeDeltaBase;
        state.targetHedgeBase = state.hedgePositionBase + hedgeDeltaBase;
        state.lastRebalanceTimestamp = block.timestamp;
        state.healthMode = HealthMode.PendingOrder;

        emit HedgeOrderCommitted(PoolId.unwrap(poolId), orderId, hedgeDeltaBase);
    }

    function settleHedgeOrder(PoolKey calldata key) external onlyKeeperOrManager nonReentrant {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        StrategyRiskState storage state = riskStates[poolId];
        bytes32 orderId = state.pendingOrderId;
        if (orderId == bytes32(0)) revert NoPendingOrder();

        IHedgeAdapter.HedgeSnapshot memory snapshot = hedgeAdapter.settleHedge(orderId);
        _applySnapshot(state, snapshot);
        if (!snapshot.pendingOrder) {
            state.pendingOrderId = bytes32(0);
            state.pendingOrderBase = 0;
        }
        _applyHealth(config, state);

        emit HedgeOrderSettled(PoolId.unwrap(poolId), orderId, state.hedgePositionBase, state.netBaseDelta);
        _emitRiskState(poolId, state);
    }

    function syncHedgeSnapshot(PoolKey calldata key) external onlyKeeperOrManager {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        StrategyRiskState storage state = riskStates[poolId];
        _refreshSnapshot(poolId, state);
        _applyHealth(config, state);
        _emitRiskState(poolId, state);
    }

    function emergencyDeRisk(PoolKey calldata key, uint256 acceptablePrice)
        external
        onlyKeeperOrManager
        nonReentrant
        returns (bytes32 orderId)
    {
        PoolId poolId = key.toId();
        _requireConfigured(poolId);
        StrategyRiskState storage state = riskStates[poolId];
        _refreshSnapshot(poolId, state);
        if (state.pendingOrderId != bytes32(0) || state.pendingOrderBase != 0) {
            revert PendingOrderExists(state.pendingOrderId);
        }

        int256 hedgeDeltaBase = -state.hedgePositionBase;
        if (hedgeDeltaBase == 0) revert NoRebalanceNeeded();

        orderId = hedgeAdapter.commitHedge(hedgeDeltaBase, acceptablePrice);
        state.pendingOrderId = orderId;
        state.pendingOrderBase = hedgeDeltaBase;
        state.targetHedgeBase = 0;
        state.lastRebalanceTimestamp = block.timestamp;
        state.healthMode = HealthMode.Defensive;

        emit EmergencyDeRiskRequested(PoolId.unwrap(poolId), orderId, hedgeDeltaBase);
    }

    function getRiskState(PoolKey calldata key) external view returns (StrategyRiskState memory) {
        return riskStates[key.toId()];
    }

    function netBaseDelta(PoolKey calldata key) external view returns (int256) {
        StrategyRiskState storage state = riskStates[key.toId()];
        return state.poolBaseExposure + state.hedgePositionBase;
    }

    function previewFee(PoolKey calldata key, SwapParams calldata params) external view returns (uint24) {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        StrategyRiskState storage state = riskStates[poolId];
        return _computeFee(config, state, params.zeroForOne);
    }

    function beforeInitialize(address, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (!key.fee.isDynamicFee()) revert MustUseDynamicFee();
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external view onlyPoolManager returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (!_isLiquidityManager(sender)) revert NotLiquidityManager();
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

    function beforeRemoveLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (!_isLiquidityManager(sender)) revert NotLiquidityManager();
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
        StrategyRiskState storage state = riskStates[poolId];
        uint24 feePips = _computeFee(config, state, params.zeroForOne);
        bool exposureIncreasing =
            _increasesExposure(state.netBaseDelta, _poolBaseExposureDirection(config, params.zeroForOne));
        emit FeeUpdated(PoolId.unwrap(poolId), feePips, exposureIncreasing, state.healthMode);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feePips | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = _requireConfigured(poolId);
        StrategyRiskState storage state = riskStates[poolId];

        int128 baseCallerDelta = config.baseIsCurrency0 ? delta.amount0() : delta.amount1();
        state.poolBaseExposure -= int256(baseCallerDelta);
        _syncDelta(config, state);

        int256 hedgeDeltaBase = _requiredHedgeDelta(config, state);
        if (hedgeDeltaBase != 0 && state.pendingOrderBase == 0) {
            state.targetHedgeBase = state.hedgePositionBase + hedgeDeltaBase;
            state.healthMode = HealthMode.NeedsRebalance;
            emit RebalanceNeeded(
                PoolId.unwrap(poolId), state.netBaseDelta, state.targetHedgeBase, hedgeDeltaBase, state.healthMode
            );
        }
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

    function _computeFee(PoolConfig storage config, StrategyRiskState storage state, bool zeroForOne)
        internal
        view
        returns (uint24)
    {
        if (state.healthMode == HealthMode.Paused) revert PoolIsPaused();
        int256 direction = _poolBaseExposureDirection(config, zeroForOne);
        bool exposureIncreasing = _increasesExposure(state.netBaseDelta, direction);
        if ((state.healthMode == HealthMode.Defensive || _isPendingOrderStale(config, state)) && exposureIncreasing) {
            revert HedgeAdapterUnhealthy();
        }

        uint24 fee = config.targetFeePips;
        if (state.netBaseDelta != 0) {
            fee = exposureIncreasing
                ? _addCapped(fee, config.inventoryFeeBumpPips, config.maxFeePips)
                : _subtractFloored(fee, config.inventoryFeeDiscountPips, config.minFeePips);
        }
        return _clamp(fee, config.minFeePips, config.maxFeePips);
    }

    function _refreshSnapshot(PoolId poolId, StrategyRiskState storage state) internal {
        IHedgeAdapter.HedgeSnapshot memory snapshot = hedgeAdapter.getSnapshot();
        _applySnapshot(state, snapshot);
        if (snapshot.pendingOrder && state.pendingOrderId == bytes32(0)) {
            state.pendingOrderId = keccak256(abi.encode(PoolId.unwrap(poolId), snapshot.pendingOrderBase));
        }
    }

    function _applySnapshot(StrategyRiskState storage state, IHedgeAdapter.HedgeSnapshot memory snapshot) internal {
        state.hedgePositionBase = snapshot.positionBase;
        state.pendingOrderBase = snapshot.pendingOrderBase;
        state.realizedPnlUsd = snapshot.realizedPnlUsd;
        state.unrealizedPnlUsd = snapshot.unrealizedPnlUsd;
        state.collateralUsd = snapshot.collateralUsd;
        if (state.initialCollateralUsd == 0 && snapshot.collateralUsd != 0) {
            state.initialCollateralUsd = snapshot.collateralUsd;
        }
        state.lastHedgePrice = snapshot.lastPrice;
        _syncDeltaFromState(state);
    }

    function _applyHealth(PoolConfig storage config, StrategyRiskState storage state) internal {
        if (state.healthMode == HealthMode.Paused) return;
        if (_isPendingOrderStale(config, state)) {
            state.healthMode = HealthMode.Defensive;
            return;
        }
        if (state.pendingOrderBase != 0 || state.pendingOrderId != bytes32(0)) {
            state.healthMode = HealthMode.PendingOrder;
            return;
        }
        if (_isMaxLossExceeded(config, state)) {
            state.healthMode = HealthMode.Defensive;
            return;
        }
        if (_abs(state.netBaseDelta) > config.maxResidualDeltaBase) {
            state.healthMode = HealthMode.NeedsRebalance;
        } else {
            state.healthMode = HealthMode.Healthy;
        }
    }

    function _requiredHedgeDelta(PoolConfig storage config, StrategyRiskState storage state) internal returns (int256) {
        _syncDeltaFromState(state);
        if (_abs(state.netBaseDelta) < config.hedgeThresholdBase) return 0;
        return -state.netBaseDelta;
    }

    function _syncDelta(PoolConfig storage, StrategyRiskState storage state) internal {
        _syncDeltaFromState(state);
    }

    function _syncDeltaFromState(StrategyRiskState storage state) internal {
        state.netBaseDelta = state.poolBaseExposure + state.hedgePositionBase;
    }

    function _requireHealthyCollateral(
        PoolConfig storage config,
        StrategyRiskState storage state,
        int256 hedgeDeltaBase
    ) internal view {
        uint256 projectedExposure = _abs(state.hedgePositionBase + hedgeDeltaBase);
        uint256 ratioRequiredUsd = (projectedExposure * config.minCollateralRatioBps) / 10_000;
        uint256 leverageRequiredUsd = (projectedExposure * 10_000) / config.maxLeverageBps;
        uint256 requiredUsd = ratioRequiredUsd > leverageRequiredUsd ? ratioRequiredUsd : leverageRequiredUsd;
        if (state.collateralUsd < requiredUsd) revert InsufficientCollateral(state.collateralUsd, requiredUsd);
        _checkMaxLoss(config, state);
    }

    function _checkMaxLoss(PoolConfig storage config, StrategyRiskState storage state) internal view {
        if (_isMaxLossExceeded(config, state)) {
            int256 pnl = state.realizedPnlUsd + state.unrealizedPnlUsd;
            uint256 maxLossUsd = (state.initialCollateralUsd * config.maxLossBps) / 10_000;
            revert MaxLossExceeded(pnl, maxLossUsd);
        }
    }

    function _isMaxLossExceeded(PoolConfig storage config, StrategyRiskState storage state)
        internal
        view
        returns (bool)
    {
        if (state.initialCollateralUsd == 0 || config.maxLossBps == 0) return false;
        int256 pnl = state.realizedPnlUsd + state.unrealizedPnlUsd;
        int256 maxLossUsd = int256((state.initialCollateralUsd * config.maxLossBps) / 10_000);
        return pnl < -maxLossUsd;
    }

    function _isPendingOrderStale(PoolConfig storage config, StrategyRiskState storage state)
        internal
        view
        returns (bool)
    {
        return state.pendingOrderBase != 0 && config.maxPendingOrderAge != 0
            && block.timestamp > state.lastRebalanceTimestamp + config.maxPendingOrderAge;
    }

    function _isLiquidityManager(address sender) internal view returns (bool) {
        return sender == owner || sender == strategyManager || liquidityManagers[sender];
    }

    function _poolBaseExposureDirection(PoolConfig storage config, bool zeroForOne) internal view returns (int256) {
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

    function _emitRiskState(PoolId poolId, StrategyRiskState storage state) internal {
        emit RiskStateSynced(
            PoolId.unwrap(poolId),
            state.poolBaseExposure,
            state.hedgePositionBase,
            state.netBaseDelta,
            state.realizedPnlUsd,
            state.unrealizedPnlUsd,
            state.collateralUsd,
            state.healthMode
        );
    }
}
