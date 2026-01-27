// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../test/mocks/MockERC20.sol";
import "../src/TokenNetwork.sol";

/**
 * @title DeployLocalScript
 * @notice Deploys MockERC20 token and TokenNetwork for local testing with Anvil
 * @dev Run with: forge script script/DeployLocal.s.sol --rpc-url http://localhost:8545 --broadcast
 */
contract DeployLocalScript is Script {
    // Anvil's default accounts (deterministic for testing)
    // Account 0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
    // Private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

    function run() external {
        // Use Anvil's first account private key
        uint256 deployerPrivateKey = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer address:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy MockERC20 token (AGENT token)
        MockERC20 agentToken = new MockERC20("Agent Token", "AGENT", 18);
        console.log("AgentToken deployed to:", address(agentToken));

        // Deploy TokenNetwork for AGENT token
        // Max deposit: 1 million tokens, Max lifetime: 365 days
        TokenNetwork tokenNetwork = new TokenNetwork(
            address(agentToken),
            1000000 * 10**18,  // maxChannelDeposit
            365 days          // maxChannelLifetime
        );
        console.log("TokenNetwork deployed to:", address(tokenNetwork));

        // Transfer tokens to agent wallets (peer-0 through peer-4)
        // These are the EVM addresses from docker-compose-agent-test.yml
        address[] memory agentAddresses = new address[](5);
        agentAddresses[0] = 0x148CC6F983d310cA7DF667601DcC4fCe632c34D6; // peer-0
        agentAddresses[1] = 0x2b26320C35e11397b55d24db47af9504D4F9E16E; // peer-1
        agentAddresses[2] = 0xc1B870D4da06AbB82230017d86E56ba36eAeC834; // peer-2
        agentAddresses[3] = 0xEDDEa9dA10E96b5E5CC79945A6569981C46Ba9BE; // peer-3
        agentAddresses[4] = 0xA3E8776eE8730E4822d89514226bdaD70839aF12; // peer-4

        uint256 tokensPerAgent = 100000 * 10**18; // 100k tokens each

        for (uint i = 0; i < agentAddresses.length; i++) {
            agentToken.transfer(agentAddresses[i], tokensPerAgent);
            console.log("Transferred 100k AGENT to:", agentAddresses[i]);
        }

        vm.stopBroadcast();

        // Output addresses in format easy to parse
        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("AGENT_TOKEN_ADDRESS=%s", address(agentToken));
        console.log("TOKEN_NETWORK_ADDRESS=%s", address(tokenNetwork));
    }
}
