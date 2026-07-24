// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../script/DeployMainnet.s.sol";
import "../src/TokenNetwork.sol";
import "../src/TokenNetworkRegistry.sol";

/// @title DeployMainnetForkTest
/// @notice Runs DeployMainnetScript against a real Base mainnet fork (no broadcast, no secrets)
///         so the eventual human broadcast is proven safe ahead of time. See issue #405 / #388.
/// @dev MUST be run with `--fork-url <base-mainnet-rpc>` (e.g. the public
///      https://mainnet.base.org, as CI does) -- this suite does NOT self-fork via
///      vm.createSelectFork in setUp(). Combining a CLI `--fork-url` with an in-test
///      vm.createSelectFork (double-forking) currently crashes forge with an upstream
///      op-revm panic ("Missing operator fee scalar for isthmus L1 Block") when forking
///      an OP-stack chain like Base, so this suite deliberately relies on the CLI flag alone:
///        forge test --match-path 'test/DeployMainnet.fork.t.sol' --fork-url https://mainnet.base.org -vvv
contract DeployMainnetForkTest is Test {
    address internal constant EXPECTED_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @notice The deployed TokenNetwork must be bound to real native USDC on Base -- not a mock.
    function testFork_DeployMainnet_BindsRealNativeUSDC() public {
        DeployMainnetScript script = new DeployMainnetScript();
        (, TokenNetwork tokenNetwork) = script.run();

        address usdc = tokenNetwork.token();
        assertEq(usdc, EXPECTED_USDC, "TokenNetwork must be bound to the base-mainnet USDC preset address");
        assertGt(usdc.code.length, 0, "USDC address must have code on the fork");

        IERC20Metadata usdcMetadata = IERC20Metadata(usdc);
        assertEq(usdcMetadata.symbol(), "USDC", "bound token must be real USDC");
        assertEq(usdcMetadata.decimals(), 6, "native USDC on Base is 6 decimals");
    }

    /// @notice Deploy caps must come from the script's env-overridable defaults, scaled for
    ///         USDC's 6 decimals -- not the registry's hardcoded 18-decimal 1M-token default.
    function testFork_DeployMainnet_UsesEnvDefaultedCaps() public {
        DeployMainnetScript script = new DeployMainnetScript();
        (, TokenNetwork tokenNetwork) = script.run();

        assertEq(tokenNetwork.maxChannelDeposit(), script.DEFAULT_MAX_CHANNEL_DEPOSIT());
        assertEq(tokenNetwork.maxChannelLifetime(), script.DEFAULT_MAX_CHANNEL_LIFETIME());
        // Sanity: the default deposit cap is 6-decimal scaled (USDC), not 18-decimal scaled.
        assertEq(script.DEFAULT_MAX_CHANNEL_DEPOSIT(), 1_000 * 10 ** 6);
    }

    /// @notice run() must not hard-require PRIVATE_KEY -- this whole fork test runs with no key,
    ///         no --broadcast, and no secrets, exactly as CI needs it to.
    function testFork_DeployMainnet_RunsKeylessWithNoBroadcast() public {
        assertEq(vm.envOr("PRIVATE_KEY", uint256(0)), 0, "this test must not have a PRIVATE_KEY available");

        DeployMainnetScript script = new DeployMainnetScript();
        (TokenNetworkRegistry registry, TokenNetwork tokenNetwork) = script.run();

        assertGt(address(registry).code.length, 0);
        assertGt(address(tokenNetwork).code.length, 0);
    }

    /// @notice No mock token is involved: the deployed TokenNetwork is bound to a real address
    ///         that is a fork of Base mainnet state, not a freshly deployed MockERC20.
    function testFork_DeployMainnet_NoMockTokenInvolved() public {
        DeployMainnetScript script = new DeployMainnetScript();
        (, TokenNetwork tokenNetwork) = script.run();

        // A MockERC20 constructed in this test would report totalSupply() == 0 (constructor
        // takes name/symbol/decimals only, no mint). Real Base-mainnet USDC has a large supply.
        assertGt(IERC20Metadata(tokenNetwork.token()).totalSupply(), 1_000_000 * 10 ** 6);
    }

    /// @notice Documents the runbook's callout: the direct-deploy TokenNetwork is deliberately
    ///         NOT registered via registry.createTokenNetwork (which hardcodes 1M/18-dec caps).
    function testFork_DeployMainnet_TokenNetworkIsNotRegisteredInRegistry() public {
        DeployMainnetScript script = new DeployMainnetScript();
        (TokenNetworkRegistry registry, TokenNetwork tokenNetwork) = script.run();

        assertEq(registry.getTokenNetwork(tokenNetwork.token()), address(0));
    }

    /// @notice USDC / cap overrides (as vm.envOr("USDC", ...) etc. would resolve to) must flow
    ///         through to the deployed TokenNetwork's constructor args.
    /// @dev Exercises the parameterized deploy() overload directly rather than vm.setEnv, since
    ///      vm.setEnv mutates the actual process environment and is not safe to use in a fork
    ///      test suite that Foundry may run in parallel with other tests in this file.
    function testFork_DeployMainnet_RespectsEnvOverrides() public {
        address overrideToken = makeAddr("overrideToken");

        DeployMainnetScript script = new DeployMainnetScript();
        (, TokenNetwork tokenNetwork) = script.deploy(overrideToken, 5_000_000, 604_800);

        assertEq(tokenNetwork.token(), overrideToken);
        assertEq(tokenNetwork.maxChannelDeposit(), 5_000_000);
        assertEq(tokenNetwork.maxChannelLifetime(), 604_800);
    }
}
