// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHedgeAdapter} from "./IHedgeAdapter.sol";

interface ISynthetixV3PerpsAdapter is IHedgeAdapter {
    function perpsMarketProxy() external view returns (address);
    function collateralToken() external view returns (address);
    function accountId() external view returns (uint128);
    function marketId() external view returns (uint128);
    function synthMarketId() external view returns (uint128);
}
