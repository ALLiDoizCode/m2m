// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/TokenNetwork.sol";
import "../src/TokenNetworkRegistry.sol";

/**
 * @title DeployMainnetScript
 * @notice Deploys TokenNetworkRegistry + a TokenNetwork bound to native USDC on Base mainnet (chainId 8453).
 * @dev Human-only broadcast: forge script script/DeployMainnet.s.sol \
 *        --rpc-url base_mainnet --broadcast --verify
 *
 *      Keyless simulation / fork-test (no broadcast, no PRIVATE_KEY required):
 *        forge script script/DeployMainnet.s.sol --fork-url https://mainnet.base.org
 *
 *      run() deliberately does NOT hard-require PRIVATE_KEY at parse time -- it falls back to an
 *      unbroadcast simulation when unset, so this script can be exercised by a Base-mainnet fork
 *      test in CI with no secrets. See README.md "Mainnet deploy runbook" for the full broadcast
 *      procedure and required env vars.
 *
 *      No MockERC20 is deployed or referenced anywhere in this script -- the token is always a
 *      real (or env-overridden) ERC20 address.
 *
 * Environment variables (all optional; conservative defaults below apply if unset):
 *   PRIVATE_KEY          - Deployer's private key. If unset, deploy() still runs (simulation only,
 *                           nothing is broadcast even with --broadcast).
 *   USDC                 - ERC20 token address to bind the TokenNetwork to.
 *                           Defaults to Circle's native USDC on Base:
 *                           0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   MAX_CHANNEL_DEPOSIT  - Max deposit per participant per channel, in the token's smallest unit.
 *                           Defaults to 1,000 * 10**6 (1,000 USDC -- native USDC on Base is 6
 *                           decimals, NOT 18).
 *   MAX_CHANNEL_LIFETIME - Max channel lifetime in seconds before force-close is allowed.
 *                           Defaults to 30 days.
 *
 * Note: this script deploys TokenNetworkRegistry alongside the TokenNetwork for architectural
 * consistency with DeployTestnet.s.sol, but does NOT call registry.createTokenNetwork(token) --
 * that function hardcodes a 1,000,000 * 10**18 deposit cap / 365-day lifetime, which is wrong for
 * 6-decimal USDC and for the conservative soak caps this script targets. The TokenNetwork here is
 * deployed directly and is therefore NOT registered in the TokenNetworkRegistry's mapping. See the
 * README runbook for details.
 */
contract DeployMainnetScript is Script {
    /// @notice Circle's native USDC on Base mainnet (chainId 8453).
    address public constant DEFAULT_USDC_BASE_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @notice Conservative initial soak cap: 1,000 USDC (6 decimals).
    uint256 public constant DEFAULT_MAX_CHANNEL_DEPOSIT = 1_000 * 10 ** 6;

    /// @notice Conservative initial soak lifetime.
    uint256 public constant DEFAULT_MAX_CHANNEL_LIFETIME = 30 days;

    /// @notice Script entrypoint. Broadcasts only if PRIVATE_KEY is set; otherwise runs as a
    ///         keyless simulation so `forge script ... --fork-url` (and fork tests) never need a key.
    function run() external returns (TokenNetworkRegistry registry, TokenNetwork tokenNetwork) {
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));
        bool shouldBroadcast = deployerPrivateKey != 0;

        if (shouldBroadcast) {
            vm.startBroadcast(deployerPrivateKey);
        } else {
            console.log("PRIVATE_KEY not set -- running keyless simulation (no broadcast)");
        }

        (registry, tokenNetwork) = deploy();

        if (shouldBroadcast) {
            vm.stopBroadcast();
        }

        logSummary(registry, tokenNetwork);
    }

    /// @notice Core deploy logic, env-defaulted via vm.envOr. Reads no PRIVATE_KEY, performs no
    ///         broadcast bookkeeping -- safe to call from run() (wrapped in broadcast) or directly
    ///         from a fork test / a keyless `forge script --fork-url` simulation.
    function deploy() public returns (TokenNetworkRegistry registry, TokenNetwork tokenNetwork) {
        address usdc = vm.envOr("USDC", DEFAULT_USDC_BASE_MAINNET);
        uint256 maxChannelDeposit = vm.envOr("MAX_CHANNEL_DEPOSIT", DEFAULT_MAX_CHANNEL_DEPOSIT);
        uint256 maxChannelLifetime = vm.envOr("MAX_CHANNEL_LIFETIME", DEFAULT_MAX_CHANNEL_LIFETIME);

        return deploy(usdc, maxChannelDeposit, maxChannelLifetime);
    }

    /// @notice Parameterized deploy logic underlying deploy(). Exposed directly so tests can
    ///         exercise the constructor-wiring behavior for overridden params without mutating
    ///         process-wide env vars via vm.setEnv (which is not safe under parallel test runs).
    function deploy(address usdc, uint256 maxChannelDeposit, uint256 maxChannelLifetime)
        public
        returns (TokenNetworkRegistry registry, TokenNetwork tokenNetwork)
    {
        registry = new TokenNetworkRegistry();
        tokenNetwork = new TokenNetwork(usdc, maxChannelDeposit, maxChannelLifetime, address(0));
    }

    function logSummary(TokenNetworkRegistry registry, TokenNetwork tokenNetwork) internal view {
        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("BASE_MAINNET_USDC_ADDRESS=%s", tokenNetwork.token());
        console.log("BASE_MAINNET_REGISTRY_ADDRESS=%s", address(registry));
        console.log("BASE_MAINNET_TOKEN_NETWORK_ADDRESS=%s", address(tokenNetwork));
        console.log("");
        console.log("maxChannelDeposit:", tokenNetwork.maxChannelDeposit());
        console.log("maxChannelLifetime:", tokenNetwork.maxChannelLifetime());
        console.log("");
        console.log("NOTE: TokenNetwork was deployed directly (not via registry.createTokenNetwork) and is");
        console.log("NOT registered in TokenNetworkRegistry's mapping. See README.md runbook.");
    }
}
