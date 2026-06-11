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

    HedgeSnapshot internal latestSnapshot;
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

    function depositCollateral(address token, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        if (token != collateralToken) revert ZeroAddress();
        IERC20Minimal(token).transferFrom(msg.sender, address(this), amount);
        IERC20Minimal(token).approve(perpsMarketProxy, amount);
        ISynthetixPerpsV3Proxy(perpsMarketProxy).modifyCollateral(accountId, synthMarketId, int256(amount));
        latestSnapshot.collateralUsd += amount;
        emit CollateralDeposited(msg.sender, token, amount);
        return latestSnapshot.collateralUsd;
    }

    function withdrawCollateral(address token, address to, uint256 amount)
        external
        override
        onlyHook
        returns (uint256 collateralUsd)
    {
        if (token != collateralToken || to == address(0)) revert ZeroAddress();
        ISynthetixPerpsV3Proxy(perpsMarketProxy).modifyCollateral(accountId, synthMarketId, -int256(amount));
        IERC20Minimal(token).transfer(to, amount);
        latestSnapshot.collateralUsd = amount > latestSnapshot.collateralUsd ? 0 : latestSnapshot.collateralUsd - amount;
        emit CollateralWithdrawn(msg.sender, token, to, amount);
        return latestSnapshot.collateralUsd;
    }

    function commitHedge(int256, uint256) external pure override returns (bytes32) {
        revert SynthetixCommitNotWired();
    }

    function settleHedge(bytes32 orderId) external override onlyHook returns (HedgeSnapshot memory snapshot) {
        ISynthetixPerpsV3Proxy(perpsMarketProxy).settleOrder(accountId);
        latestSnapshot.pendingOrder = false;
        latestSnapshot.pendingOrderBase = 0;
        emit HedgeOrderSettled(orderId, 0, latestSnapshot.realizedPnlUsd);
        return latestSnapshot;
    }

    function getSnapshot() external view override returns (HedgeSnapshot memory snapshot) {
        return latestSnapshot;
    }
}
