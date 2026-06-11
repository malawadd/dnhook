// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {DeltaNeutralHook} from "../src/DeltaNeutralHook.sol";
import {HookAddressMiner} from "../src/libraries/HookAddressMiner.sol";

contract HookAddressMinerTest is Test {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant OWNER = 0x840C1b6ce85bBFEbcFAd737514c0097B078a7E7E;

    function test_findMinesExactHookFlags() public pure {
        uint160 flags =
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(IPoolManager(POOL_MANAGER), OWNER);

        (address hookAddress, bytes32 salt) =
            HookAddressMiner.find(CREATE2_DEPLOYER, flags, type(DeltaNeutralHook).creationCode, constructorArgs);

        bytes32 initCodeHash = keccak256(abi.encodePacked(type(DeltaNeutralHook).creationCode, constructorArgs));
        address recomputed = HookAddressMiner.computeAddress(CREATE2_DEPLOYER, salt, initCodeHash);

        assertEq(hookAddress, recomputed);
        assertEq(uint160(hookAddress) & HookAddressMiner.allHookMask(), flags);
    }
}
