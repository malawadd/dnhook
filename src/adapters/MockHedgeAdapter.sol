// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";
import {IHedgeAdapter} from "../interfaces/IHedgeAdapter.sol";

contract MockHedgeAdapter is IHedgeAdapter {
    mapping(bytes32 strategyId => HedgeSnapshot snapshot) internal snapshots;
    address public hook;
    bytes32 public latestOrderId;
    mapping(bytes32 strategyId => int256 nextFillBase) public nextFillBase;
    mapping(bytes32 strategyId => int256 nextRealizedPnlUsd) public nextRealizedPnlUsd;
    mapping(bytes32 strategyId => uint256 nextMarkPrice) public nextMarkPrice;

    error NotHook();

    modifier onlyHook() {
        if (hook != address(0) && msg.sender != hook) revert NotHook();
        _;
    }

    function setHook(address _hook) external {
        hook = _hook;
    }

    function setSnapshot(bytes32 strategyId, HedgeSnapshot calldata nextSnapshot) external {
        snapshots[strategyId] = nextSnapshot;
        snapshots[strategyId].strategyId = strategyId;
    }

    function setNextSettlement(bytes32 strategyId, int256 fillBase, int256 realizedPnlUsd, uint256 markPrice) external {
        nextFillBase[strategyId] = fillBase;
        nextRealizedPnlUsd[strategyId] = realizedPnlUsd;
        nextMarkPrice[strategyId] = markPrice;
    }

    function depositCollateral(bytes32 strategyId, address token, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        HedgeSnapshot storage snapshot = snapshots[strategyId];
        IERC20Minimal(token).transferFrom(msg.sender, address(this), amount);
        snapshot.strategyId = strategyId;
        snapshot.collateralUsd += amount;
        if (snapshot.markPrice == 0) snapshot.markPrice = 2_000 ether;
        if (snapshot.updatedAt == 0) snapshot.updatedAt = block.timestamp;
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
        HedgeSnapshot storage snapshot = snapshots[strategyId];
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
        HedgeSnapshot storage snapshot = snapshots[strategyId];
        latestOrderId = keccak256(abi.encode(strategyId, block.number, sizeDeltaBase, acceptablePrice));
        snapshot.strategyId = strategyId;
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
        HedgeSnapshot storage snapshot = snapshots[strategyId];
        require(snapshot.pendingOrderId == orderId, "MockHedgeAdapter: wrong order");
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
}
