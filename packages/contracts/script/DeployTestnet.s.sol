// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../test/mocks/MockERC20.sol";
import "../src/TokenNetwork.sol";
import "../src/TokenNetworkRegistry.sol";

/**
 * @title DeployTestnetScript
 * @notice Deploys the TOON payment-channel contracts + a 6-decimal mock USDC to
 *         the Base Sepolia public testnet (chainId 84532), for the devnet nodes'
 *         EVM settlement to point at.
 * @dev Run with:
 *      forge script script/DeployTestnet.s.sol --rpc-url https://sepolia.base.org --broadcast
 *
 * Deploys, in one broadcast:
 *   1. TokenNetworkRegistry (the factory the connector resolves TokenNetworks through)
 *   2. A 6-decimal mock USDC ("USD Coin (mock)", "USDC") — decimals match the
 *      USDC theme used on the Solana/Mina settlement chains.
 *   3. A TokenNetwork for the mock USDC, created *through the registry* so that
 *      `registry.getTokenNetwork(usdc)` resolves it (this is how the connector
 *      finds the TokenNetwork at runtime, given only registryAddress + tokenAddress).
 *   4. Mints a large mock-USDC supply to the deployer so it can distribute to node
 *      settlement identities / clients later.
 *
 * Environment variables required:
 *   PRIVATE_KEY - The deployer's private key (0x-prefixed hex)
 */
contract DeployTestnetScript is Script {
    // 100,000,000 USDC (6 decimals) minted to the deployer for later distribution,
    // on top of the 1,000,000 USDC the MockERC20 constructor mints to msg.sender.
    uint256 internal constant DISTRIBUTOR_MINT = 100_000_000 * 10 ** 6;

    function run() external {
        // Load private key from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer address:", deployer);
        console.log("Deployer balance:", deployer.balance);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy TokenNetworkRegistry (permissionless: whitelist disabled by default)
        TokenNetworkRegistry registry = new TokenNetworkRegistry();
        console.log("TokenNetworkRegistry deployed to:", address(registry));

        // 2. Deploy 6-decimal mock USDC. Constructor mints 1,000,000 USDC to the deployer.
        MockERC20 usdc = new MockERC20("USD Coin (mock)", "USDC", 6);
        console.log("MockUSDC deployed to:", address(usdc));

        // 3. Create + register the TokenNetwork for the mock USDC THROUGH the registry,
        //    so the connector can resolve it via registry.getTokenNetwork(usdc).
        address tokenNetwork = registry.createTokenNetwork(address(usdc));
        console.log("TokenNetwork(USDC) deployed to:", tokenNetwork);

        // 4. Mint a large mock-USDC supply to the deployer for distribution.
        usdc.mint(deployer, DISTRIBUTOR_MINT);
        console.log("Minted extra USDC (base units) to deployer:", DISTRIBUTOR_MINT);
        console.log("Deployer USDC balance (base units):", usdc.balanceOf(deployer));

        vm.stopBroadcast();

        // Output addresses in format easy to parse
        console.log("");
        console.log("=== DEPLOYMENT COMPLETE (Base Sepolia / chainId 84532) ===");
        console.log("BASE_REGISTRY_ADDRESS=%s", address(registry));
        console.log("BASE_USDC_TOKEN_ADDRESS=%s", address(usdc));
        console.log("BASE_TOKEN_NETWORK_ADDRESS=%s", tokenNetwork);
        console.log("");
        console.log("Add these to your environment or testnet-wallets.json:");
        console.log("  export BASE_REGISTRY_ADDRESS=%s", address(registry));
        console.log("  export BASE_USDC_TOKEN_ADDRESS=%s", address(usdc));
        console.log("  export BASE_TOKEN_NETWORK_ADDRESS=%s", tokenNetwork);
    }
}
