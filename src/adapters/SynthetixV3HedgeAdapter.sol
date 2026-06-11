// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";
import {IHedgeAdapter} from "../interfaces/IHedgeAdapter.sol";
import {ISynthetixV3PerpsAdapter} from "../interfaces/ISynthetixV3PerpsAdapter.sol";

interface ISynthetixPerpsV3Proxy {
    function modifyCollateral(uint128 accountId, uint128 synthMarketId, int256 amountDelta) external;
    function settleOrder(uint128 accountId) external;
}

/// @notice Adapter boundary for a future Synthetix Perps V3 integration.
/// @dev The exact perps commit/snapshot methods are intentionally isolated here so the hook policy stays venue-agnostic.
contract SynthetixV3HedgeAdapter is ISynthetixV3PerpsAdapter {
    address public immutable override perpsMarketProxy;
    address public immutable override collateralToken;
    uint128 public immutable override accountId;
    uint128 public immutable override marketId;
    uint128 public immutable override synthMarketId;
    address public hook;

    mapping(bytes32 strategyId => HedgeSnapshot snapshot) internal latestSnapshots;
    bytes32 public latestOrderId;

    error NotHook();
    error HookAlreadySet();
    error ZeroAddress();
    error SynthetixCommitNotWired();

    modifier onlyHook() {
        if (msg.sender != hook) revert NotHook();
        _;
    }

    constructor(
        address _perpsMarketProxy,
        address _collateralToken,
        uint128 _accountId,
        uint128 _marketId,
        uint128 _synthMarketId
    ) {
        if (_perpsMarketProxy == address(0) || _collateralToken == address(0)) revert ZeroAddress();
        perpsMarketProxy = _perpsMarketProxy;
        collateralToken = _collateralToken;
        accountId = _accountId;
        marketId = _marketId;
        synthMarketId = _synthMarketId;
    }

    function setHook(address _hook) external {
        if (_hook == address(0)) revert ZeroAddress();
        if (hook != address(0)) revert HookAlreadySet();
        hook = _hook;
    }

    function depositCollateral(bytes32 strategyId, address token, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        if (token != collateralToken) revert ZeroAddress();
        IERC20Minimal(token).transferFrom(msg.sender, address(this), amount);
        IERC20Minimal(token).approve(perpsMarketProxy, amount);
        ISynthetixPerpsV3Proxy(perpsMarketProxy).modifyCollateral(accountId, synthMarketId, int256(amount));
        HedgeSnapshot storage snapshot = latestSnapshots[strategyId];
        snapshot.strategyId = strategyId;
        snapshot.collateralUsd += amount;
        snapshot.updatedAt = block.timestamp;
        emit CollateralDeposited(strategyId, msg.sender, token, amount);
        return snapshot.collateralUsd;
    }

    function withdrawCollateral(bytes32 strategyId, address token, address to, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        if (token != collateralToken || to == address(0)) revert ZeroAddress();
        ISynthetixPerpsV3Proxy(perpsMarketProxy).modifyCollateral(accountId, synthMarketId, -int256(amount));
        IERC20Minimal(token).transfer(to, amount);
        HedgeSnapshot storage snapshot = latestSnapshots[strategyId];
        snapshot.strategyId = strategyId;
        snapshot.collateralUsd = amount > snapshot.collateralUsd ? 0 : snapshot.collateralUsd - amount;
        snapshot.updatedAt = block.timestamp;
        emit CollateralWithdrawn(strategyId, msg.sender, token, to, amount);
        return snapshot.collateralUsd;
    }

    function commitHedge(bytes32, int256, uint256) external pure override returns (bytes32) {
        revert SynthetixCommitNotWired();
    }

    function settleHedge(bytes32 strategyId, bytes32 orderId)
        external
        override
        onlyHook
        returns (HedgeSnapshot memory snapshot)
    {
        ISynthetixPerpsV3Proxy(perpsMarketProxy).settleOrder(accountId);
        latestSnapshots[strategyId].pendingOrderId = bytes32(0);
        latestSnapshots[strategyId].pendingOrderBase = 0;
        latestSnapshots[strategyId].updatedAt = block.timestamp;
        emit HedgeOrderSettled(strategyId, orderId, 0, latestSnapshots[strategyId].realizedPnlUsd);
        return latestSnapshots[strategyId];
    }

    function getSnapshot(bytes32 strategyId) external view override returns (HedgeSnapshot memory snapshot) {
        return latestSnapshots[strategyId];
    }
}
