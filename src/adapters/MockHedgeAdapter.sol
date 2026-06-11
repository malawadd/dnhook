// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";
import {IHedgeAdapter} from "../interfaces/IHedgeAdapter.sol";

contract MockHedgeAdapter is IHedgeAdapter {
    HedgeSnapshot public snapshot;
    address public hook;
    bytes32 public latestOrderId;
    int256 public nextFillBase;
    int256 public nextRealizedPnlUsd;
    uint256 public nextLastPrice;

    error NotHook();

    modifier onlyHook() {
        if (hook != address(0) && msg.sender != hook) revert NotHook();
        _;
    }

    function setHook(address _hook) external {
        hook = _hook;
    }

    function setSnapshot(HedgeSnapshot calldata nextSnapshot) external {
        snapshot = nextSnapshot;
    }

    function setNextSettlement(int256 fillBase, int256 realizedPnlUsd, uint256 lastPrice) external {
        nextFillBase = fillBase;
        nextRealizedPnlUsd = realizedPnlUsd;
        nextLastPrice = lastPrice;
    }

    function depositCollateral(address token, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        IERC20Minimal(token).transferFrom(msg.sender, address(this), amount);
        snapshot.collateralUsd += amount;
        snapshot.healthy = true;
        emit CollateralDeposited(msg.sender, token, amount);
        return snapshot.collateralUsd;
    }

    function withdrawCollateral(address token, address to, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        snapshot.collateralUsd = amount > snapshot.collateralUsd ? 0 : snapshot.collateralUsd - amount;
        IERC20Minimal(token).transfer(to, amount);
        emit CollateralWithdrawn(msg.sender, token, to, amount);
        return snapshot.collateralUsd;
    }

    function commitHedge(int256 sizeDeltaBase, uint256 acceptablePrice)
        external
        override
        onlyHook
        returns (bytes32 orderId)
    {
        latestOrderId = keccak256(abi.encode(block.number, sizeDeltaBase, acceptablePrice));
        snapshot.pendingOrder = true;
        snapshot.pendingOrderBase = sizeDeltaBase;
        emit HedgeOrderCommitted(latestOrderId, sizeDeltaBase, acceptablePrice);
        return latestOrderId;
    }

    function settleHedge(bytes32 orderId) external override onlyHook returns (HedgeSnapshot memory settledSnapshot) {
        int256 fillBase = nextFillBase == 0 ? snapshot.pendingOrderBase : nextFillBase;
        snapshot.positionBase += fillBase;
        snapshot.pendingOrderBase = 0;
        snapshot.pendingOrder = false;
        snapshot.realizedPnlUsd += nextRealizedPnlUsd;
        if (nextLastPrice != 0) snapshot.lastPrice = nextLastPrice;
        emit HedgeOrderSettled(orderId, fillBase, nextRealizedPnlUsd);

        nextFillBase = 0;
        nextRealizedPnlUsd = 0;
        nextLastPrice = 0;
        return snapshot;
    }

    function getSnapshot() external view override returns (HedgeSnapshot memory) {
        return snapshot;
    }
}
