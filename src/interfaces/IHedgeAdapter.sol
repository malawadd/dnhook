// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IHedgeAdapter {
    struct HedgeSnapshot {
        int256 positionBase;
        int256 pendingOrderBase;
        int256 realizedPnlUsd;
        int256 unrealizedPnlUsd;
        uint256 collateralUsd;
        uint256 lastPrice;
        bool pendingOrder;
        bool healthy;
    }

    event CollateralDeposited(address indexed caller, address indexed token, uint256 amount);
    event CollateralWithdrawn(address indexed caller, address indexed token, address indexed to, uint256 amount);
    event HedgeOrderCommitted(bytes32 indexed orderId, int256 sizeDeltaBase, uint256 acceptablePrice);
    event HedgeOrderSettled(bytes32 indexed orderId, int256 filledBase, int256 realizedPnlUsd);

    function depositCollateral(address token, uint256 amount) external returns (uint256 collateralUsd);
    function withdrawCollateral(address token, address to, uint256 amount) external returns (uint256 collateralUsd);
    function commitHedge(int256 sizeDeltaBase, uint256 acceptablePrice) external returns (bytes32 orderId);
    function settleHedge(bytes32 orderId) external returns (HedgeSnapshot memory snapshot);
    function getSnapshot() external view returns (HedgeSnapshot memory snapshot);
}
