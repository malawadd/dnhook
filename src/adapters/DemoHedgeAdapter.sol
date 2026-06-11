// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";
import {IHedgeAdapter} from "../interfaces/IHedgeAdapter.sol";

/// @notice Role-gated demo hedge adapter that models an async perps venue for live demos.
/// @dev This adapter is intentionally controllable by demo operators; do not use it as a real hedge venue.
contract DemoHedgeAdapter is IHedgeAdapter {
    mapping(bytes32 strategyId => HedgeSnapshot snapshot) internal snapshots;
    mapping(bytes32 strategyId => int256 nextFillBase) public nextFillBase;
    mapping(bytes32 strategyId => int256 nextRealizedPnlUsd) public nextRealizedPnlUsd;
    mapping(bytes32 strategyId => uint256 nextMarkPrice) public nextMarkPrice;
    mapping(address account => bool allowed) public operators;

    address public owner;
    address public hook;
    bytes32 public latestOrderId;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed operator, bool allowed);
    event HookUpdated(address indexed hook);
    event DemoSnapshotUpdated(
        bytes32 indexed strategyId,
        bool healthy,
        uint256 collateralUsd,
        uint256 markPrice,
        int256 realizedPnlUsd,
        int256 unrealizedPnlUsd,
        uint256 updatedAt
    );
    event DemoSettlementPlanUpdated(
        bytes32 indexed strategyId, int256 fillBase, int256 realizedPnlUsd, uint256 markPrice
    );

    error NotOwner();
    error NotOperator();
    error NotHook();
    error InvalidAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner && !operators[msg.sender]) revert NotOperator();
        _;
    }

    modifier onlyHook() {
        if (hook != address(0) && msg.sender != hook) revert NotHook();
        _;
    }

    constructor(address initialOwner, address initialOperator) {
        if (initialOwner == address(0) || initialOperator == address(0)) revert InvalidAddress();
        owner = initialOwner;
        operators[initialOwner] = true;
        operators[initialOperator] = true;
        emit OwnerTransferred(address(0), initialOwner);
        emit OperatorUpdated(initialOwner, true);
        emit OperatorUpdated(initialOperator, true);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
        operators[newOwner] = true;
        emit OperatorUpdated(newOwner, true);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    function setHook(address newHook) external onlyOwner {
        if (newHook == address(0)) revert InvalidAddress();
        hook = newHook;
        emit HookUpdated(newHook);
    }

    function setHealthy(bytes32 strategyId, bool healthy) external onlyOperator {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        snapshot.healthy = healthy;
        snapshot.updatedAt = block.timestamp;
        _emitDemoSnapshot(strategyId, snapshot);
    }

    function setMarkPrice(bytes32 strategyId, uint256 markPrice) external onlyOperator {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        snapshot.markPrice = markPrice;
        snapshot.updatedAt = block.timestamp;
        _emitDemoSnapshot(strategyId, snapshot);
    }

    function setCollateralUsd(bytes32 strategyId, uint256 collateralUsd) external onlyOperator {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        snapshot.collateralUsd = collateralUsd;
        snapshot.updatedAt = block.timestamp;
        _emitDemoSnapshot(strategyId, snapshot);
    }

    function setPnl(bytes32 strategyId, int256 realizedPnlUsd, int256 unrealizedPnlUsd) external onlyOperator {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        snapshot.realizedPnlUsd = realizedPnlUsd;
        snapshot.unrealizedPnlUsd = unrealizedPnlUsd;
        snapshot.updatedAt = block.timestamp;
        _emitDemoSnapshot(strategyId, snapshot);
    }

    function makeSnapshotStale(bytes32 strategyId, uint256 secondsAgo) external onlyOperator {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        snapshot.updatedAt = block.timestamp > secondsAgo ? block.timestamp - secondsAgo : 1;
        snapshot.healthy = true;
        _emitDemoSnapshot(strategyId, snapshot);
    }

    function resetDemoSnapshot(bytes32 strategyId, uint256 markPrice, uint256 collateralUsd) external onlyOperator {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        snapshot.markPrice = markPrice;
        snapshot.collateralUsd = collateralUsd;
        snapshot.realizedPnlUsd = 0;
        snapshot.unrealizedPnlUsd = 0;
        snapshot.updatedAt = block.timestamp;
        snapshot.healthy = true;
        _emitDemoSnapshot(strategyId, snapshot);
    }

    function setNextSettlement(bytes32 strategyId, int256 fillBase, int256 realizedPnlUsd, uint256 markPrice)
        external
        onlyOperator
    {
        nextFillBase[strategyId] = fillBase;
        nextRealizedPnlUsd[strategyId] = realizedPnlUsd;
        nextMarkPrice[strategyId] = markPrice;
        emit DemoSettlementPlanUpdated(strategyId, fillBase, realizedPnlUsd, markPrice);
    }

    function depositCollateral(bytes32 strategyId, address token, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        IERC20Minimal(token).transferFrom(msg.sender, address(this), amount);
        snapshot.collateralUsd += amount;
        if (snapshot.markPrice == 0) snapshot.markPrice = 2_000 ether;
        snapshot.updatedAt = block.timestamp;
        snapshot.healthy = true;
        emit CollateralDeposited(strategyId, msg.sender, token, amount);
        return snapshot.collateralUsd;
    }

    function withdrawCollateral(bytes32 strategyId, address token, address to, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        snapshot.collateralUsd = amount > snapshot.collateralUsd ? 0 : snapshot.collateralUsd - amount;
        snapshot.updatedAt = block.timestamp;
        IERC20Minimal(token).transfer(to, amount);
        emit CollateralWithdrawn(strategyId, msg.sender, token, to, amount);
        return snapshot.collateralUsd;
    }

    function commitHedge(bytes32 strategyId, int256 sizeDeltaBase, uint256 acceptablePrice)
        external
        override
        onlyHook
        returns (bytes32 orderId)
    {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        latestOrderId = keccak256(abi.encode(strategyId, block.number, sizeDeltaBase, acceptablePrice));
        snapshot.pendingOrderId = latestOrderId;
        snapshot.pendingOrderBase = sizeDeltaBase;
        snapshot.settlementReadyAt = block.timestamp;
        snapshot.updatedAt = block.timestamp;
        if (snapshot.markPrice == 0) snapshot.markPrice = acceptablePrice;
        snapshot.healthy = true;
        emit HedgeOrderCommitted(strategyId, latestOrderId, sizeDeltaBase, acceptablePrice);
        return latestOrderId;
    }

    function settleHedge(bytes32 strategyId, bytes32 orderId)
        external
        override
        onlyHook
        returns (HedgeSnapshot memory settledSnapshot)
    {
        HedgeSnapshot storage snapshot = _snapshot(strategyId);
        require(snapshot.pendingOrderId == orderId, "DemoHedgeAdapter: wrong order");
        int256 fillBase = nextFillBase[strategyId] == 0 ? snapshot.pendingOrderBase : nextFillBase[strategyId];
        snapshot.positionBase += fillBase;
        snapshot.pendingOrderBase = 0;
        snapshot.pendingOrderId = bytes32(0);
        snapshot.realizedPnlUsd += nextRealizedPnlUsd[strategyId];
        if (nextMarkPrice[strategyId] != 0) snapshot.markPrice = nextMarkPrice[strategyId];
        snapshot.updatedAt = block.timestamp;
        snapshot.settlementReadyAt = 0;
        snapshot.healthy = true;
        emit HedgeOrderSettled(strategyId, orderId, fillBase, nextRealizedPnlUsd[strategyId]);

        nextFillBase[strategyId] = 0;
        nextRealizedPnlUsd[strategyId] = 0;
        nextMarkPrice[strategyId] = 0;
        return snapshot;
    }

    function getSnapshot(bytes32 strategyId) external view override returns (HedgeSnapshot memory) {
        return snapshots[strategyId];
    }

    function _snapshot(bytes32 strategyId) internal returns (HedgeSnapshot storage snapshot) {
        snapshot = snapshots[strategyId];
        snapshot.strategyId = strategyId;
        if (snapshot.markPrice == 0) snapshot.markPrice = 2_000 ether;
    }

    function _emitDemoSnapshot(bytes32 strategyId, HedgeSnapshot storage snapshot) internal {
        emit DemoSnapshotUpdated(
            strategyId,
            snapshot.healthy,
            snapshot.collateralUsd,
            snapshot.markPrice,
            snapshot.realizedPnlUsd,
            snapshot.unrealizedPnlUsd,
            snapshot.updatedAt
        );
    }
}
