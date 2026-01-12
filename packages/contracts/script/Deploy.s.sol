// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/TokenNetworkRegistry.sol";

/**
 * @title DeployScript
 * @notice Deployment script for TokenNetworkRegistry contracts
 * @dev Run with: forge script script/Deploy.s.sol --rpc-url <network> --broadcast
 */
contract DeployScript is Script {
    function run() external {
        // Load private key from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);

        // Deploy TokenNetworkRegistry contract
        TokenNetworkRegistry registry = new TokenNetworkRegistry();

        // Log deployed address
        console.log("TokenNetworkRegistry deployed to:", address(registry));

        // Stop broadcasting
        vm.stopBroadcast();
    }
}
