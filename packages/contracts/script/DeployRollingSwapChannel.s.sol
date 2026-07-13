// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/RollingSwapChannel.sol";

/**
 * @title DeployRollingSwapChannelScript
 * @notice Deploys the rolling-swap chain-B settlement contract (connector#315)
 *         for a specific ERC20 settlement token on a real network.
 * @dev Run with:
 *   TOKEN_ADDRESS=0x... CHALLENGE_PERIOD=86400 PRIVATE_KEY=0x... \
 *     forge script script/DeployRollingSwapChannel.s.sol \
 *       --rpc-url <network> --broadcast
 *
 *   TOKEN_ADDRESS    — the ERC20 the destination-chain recipient settles in
 *                      (e.g. USDC on Base).
 *   CHALLENGE_PERIOD — unilateral-close challenge window, seconds (>= 3600).
 *                      Defaults to 1 day if unset.
 */
contract DeployRollingSwapChannelScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address tokenAddress = vm.envAddress("TOKEN_ADDRESS");
        uint256 challengePeriod = vm.envOr("CHALLENGE_PERIOD", uint256(1 days));

        vm.startBroadcast(deployerPrivateKey);

        RollingSwapChannel channel = new RollingSwapChannel(tokenAddress, challengePeriod);

        console.log("RollingSwapChannel deployed to:", address(channel));
        console.log("  token:", tokenAddress);
        console.log("  challengePeriod:", challengePeriod);

        vm.stopBroadcast();
    }
}
