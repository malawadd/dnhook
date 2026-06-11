// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IHedgeAdapter {
    struct HedgeSnapshot {
        bytes32 strategyId;
        int256 positionBase;
        int256 pendingOrderBase;
        bytes32 pendingOrderId;
        int256 realizedPnlUsd;
        int256 unrealizedPnlUsd;
        uint256 collateralUsd;
        uint256 markPrice;
        uint256 updatedAt;
        uint256 settlementReadyAt;
        bool healthy;
    }

    event CollateralDeposited(
        bytes32 indexed strategyId, address indexed caller, address indexed token, uint256 amount
    );
    event CollateralWithdrawn(
        bytes32 indexed strategyId, address indexed caller, address indexed token, address to, uint256 amount
    );
    event HedgeOrderCommitted(
        bytes32 indexed strategyId, bytes32 indexed orderId, int256 sizeDeltaBase, uint256 acceptablePrice
    );
    event HedgeOrderSettled(
        bytes32 indexed strategyId, bytes32 indexed orderId, int256 filledBase, int256 realizedPnlUsd
    );

    function depositCollateral(bytes32 strategyId, address token, uint256 amount)
        external
        returns (uint256 collateralUsd);
    function withdrawCollateral(bytes32 strategyId, address token, address to, uint256 amount)
        external
        returns (uint256 collateralUsd);
    function commitHedge(bytes32 strategyId, int256 sizeDeltaBase, uint256 acceptablePrice)
        external
        returns (bytes32 orderId);
    function settleHedge(bytes32 strategyId, bytes32 orderId) external returns (HedgeSnapshot memory snapshot);
    function getSnapshot(bytes32 strategyId) external view returns (HedgeSnapshot memory snapshot);
}
