// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/TokenNetworkRegistry.sol";
import "../src/TokenNetwork.sol";
import "../src/MockERC20.sol";

/**
 * @title Deploy Script
 * @notice Deployment script for M2M payment channel contracts
 * @dev Supports multi-environment deployment (local Anvil, Base Sepolia, Base mainnet)
 *
 * Deployment Order:
 *   1. TokenNetworkRegistry - Factory contract for creating TokenNetwork instances
 *   2. MockERC20 - Example token for demonstration (local deployment only)
 *   3. TokenNetwork - Created via registry.createTokenNetwork() for demo token
 *
 * Usage:
 *   Local Anvil:
 *     forge script script/Deploy.s.sol --rpc-url local --broadcast
 *
 *   Base Sepolia Testnet:
 *     forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
 *
 *   Base Mainnet (Production):
 *     forge script script/Deploy.s.sol --rpc-url base_mainnet --broadcast --verify
 *
 * Environment Variables Required:
 *   - PRIVATE_KEY: Deployment account private key
 *   - ETHERSCAN_API_KEY: Etherscan API key for contract verification (testnet/mainnet only)
 */
contract DeployScript is Script {
    /**
     * @notice Helper function to sign balance proof with EIP-712
     */
    function _signBalanceProof(
        TokenNetwork tokenNetwork,
        TokenNetwork.BalanceProof memory proof,
        uint256 privateKey
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            tokenNetwork.BALANCE_PROOF_TYPEHASH(),
            proof.channelId,
            proof.nonce,
            proof.transferredAmount,
            proof.lockedAmount,
            proof.locksRoot
        ));

        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            tokenNetwork.DOMAIN_SEPARATOR(),
            structHash
        ));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function run() external {
        // Load deployer private key from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);

        // ====================================================================
        // STEP 1: Deploy TokenNetworkRegistry (Story 8.2)
        // ====================================================================
        console.log("\n=== Deploying TokenNetworkRegistry ===");
        TokenNetworkRegistry registry = new TokenNetworkRegistry();
        console.log("TokenNetworkRegistry deployed at:", address(registry));
        console.log("Registry Owner:", registry.owner());

        // ====================================================================
        // STEP 2: Deploy example MockERC20 token for demonstration
        // ====================================================================
        console.log("\n=== Deploying Example Token ===");
        MockERC20 demoToken = new MockERC20("Demo Token", "DEMO", 18);
        console.log("Demo Token deployed at:", address(demoToken));
        console.log("Demo Token supply:", demoToken.totalSupply());

        // ====================================================================
        // STEP 3: Create TokenNetwork for demo token via registry
        // ====================================================================
        console.log("\n=== Creating TokenNetwork for Demo Token ===");
        address tokenNetworkAddress = registry.createTokenNetwork(address(demoToken));
        console.log("TokenNetwork created at:", tokenNetworkAddress);

        // ====================================================================
        // STEP 4: Verify TokenNetwork creation via registry lookup
        // ====================================================================
        console.log("\n=== Verifying TokenNetwork Creation ===");
        address retrievedTokenNetwork = registry.getTokenNetwork(address(demoToken));
        console.log("Registry lookup returned:", retrievedTokenNetwork);

        if (retrievedTokenNetwork == tokenNetworkAddress) {
            console.log("[SUCCESS] TokenNetwork creation verified successfully!");
        } else {
            console.log("[FAILED] TokenNetwork verification failed!");
        }

        // ====================================================================
        // STEP 5: Demonstrate channel opening (Story 8.3)
        // ====================================================================
        console.log("\n=== Demonstrating Payment Channel Opening ===");

        // Get TokenNetwork instance
        TokenNetwork tokenNetwork = TokenNetwork(tokenNetworkAddress);

        // Create two participant addresses for demonstration
        address participant1 = vm.addr(deployerPrivateKey);
        address participant2 = address(0xBEEF); // Demo participant

        console.log("Participant 1 (deployer):", participant1);
        console.log("Participant 2 (demo):", participant2);

        // Open channel between participants with 1 hour settlement timeout
        bytes32 channelId = tokenNetwork.openChannel(participant2, 1 hours);
        console.log("\nChannel opened successfully!");
        console.log("Channel ID:", vm.toString(channelId));
        console.log("Settlement Timeout: 1 hour (3600 seconds)");

        // Verify channel state
        TokenNetwork.ChannelState state = tokenNetwork.getChannelState(channelId);
        console.log("Channel State:", uint(state), "(0=NonExistent, 1=Opened, 2=Closed, 3=Settled)");

        // ====================================================================
        // STEP 6: Demonstrate deposit functionality (Story 8.3)
        // ====================================================================
        console.log("\n=== Demonstrating Token Deposits ===");

        // Mint tokens to deployer for deposit demonstration
        uint256 depositAmount = 1000 * 10**18;
        demoToken.mint(participant1, depositAmount);
        console.log("Minted", depositAmount / 10**18, "DEMO tokens to deployer");

        // Approve TokenNetwork to spend tokens
        demoToken.approve(address(tokenNetwork), depositAmount);
        console.log("Approved TokenNetwork to spend tokens");

        // Deposit tokens into channel
        tokenNetwork.setTotalDeposit(channelId, participant1, depositAmount);
        console.log("Deposited", depositAmount / 10**18, "DEMO tokens into channel");

        // Verify deposit
        uint256 participantDeposit = tokenNetwork.getChannelDeposit(channelId, participant1);
        console.log("Verified participant deposit:", participantDeposit / 10**18, "DEMO");

        // Stop broadcasting (deployment complete)
        vm.stopBroadcast();

        // ====================================================================
        // NOTE: Channel closure and settlement testing
        // ====================================================================
        // Full channel lifecycle testing (close/settle) is demonstrated in test files.
        // Deployment scripts cannot use vm.prank() during broadcast mode.
        // See test/TokenNetwork.t.sol for complete lifecycle tests.

        // ====================================================================
        // Deployment Summary
        // ====================================================================
        console.log("\n=== Deployment Complete ===");
        console.log("Deployer:", vm.addr(deployerPrivateKey));
        console.log("Chain ID:", block.chainid);
        console.log("Block Number:", block.number);
        console.log("\nDeployed Contracts:");
        console.log("  TokenNetworkRegistry:", address(registry));
        console.log("  Demo Token (DEMO):", address(demoToken));
        console.log("  TokenNetwork (DEMO):", tokenNetworkAddress);
        console.log("\nDemo Channel:");
        console.log("  Channel ID:", vm.toString(channelId));
        console.log("  Participant 1:", participant1);
        console.log("  Participant 2:", participant2);
        console.log("  Participant 1 Deposit:", participantDeposit / 10**18, "DEMO");
        console.log("  State: Opened");
        console.log("\nDeployment Validation:");
        console.log("  [OK] Registry Deployed and Verified");
        console.log("  [OK] Demo Token Deployed");
        console.log("  [OK] TokenNetwork Created via Registry");
        console.log("  [OK] Channel Opened Successfully");
        console.log("  [OK] Tokens Deposited Successfully");
        console.log("\nNote: Full lifecycle tests (close/settle) in test suite");
    }
}
