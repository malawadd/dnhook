// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Small CREATE2 helper for mining Uniswap v4 hook permission addresses.
library HookAddressMiner {
    uint160 internal constant ALL_HOOK_MASK = uint160((1 << 14) - 1);
    uint256 internal constant DEFAULT_MAX_ITERATIONS = 200_000;

    error HookSaltNotFound(uint160 flags, uint256 maxIterations);

    function allHookMask() internal pure returns (uint160) {
        return ALL_HOOK_MASK;
    }

    function find(address create2Deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        pure
        returns (address hookAddress, bytes32 salt)
    {
        return find(create2Deployer, flags, creationCode, constructorArgs, DEFAULT_MAX_ITERATIONS);
    }

    function find(
        address create2Deployer,
        uint160 flags,
        bytes memory creationCode,
        bytes memory constructorArgs,
        uint256 maxIterations
    ) internal pure returns (address hookAddress, bytes32 salt) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));

        for (uint256 i = 0; i < maxIterations; ++i) {
            salt = bytes32(i);
            hookAddress = computeAddress(create2Deployer, salt, initCodeHash);
            if (uint160(hookAddress) & ALL_HOOK_MASK == flags) return (hookAddress, salt);
        }

        revert HookSaltNotFound(flags, maxIterations);
    }

    function computeAddress(address create2Deployer, bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address)
    {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), create2Deployer, salt, initCodeHash)))
            )
        );
    }
}
