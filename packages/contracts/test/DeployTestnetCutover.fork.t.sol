// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import "../script/DeployTestnetCutover.s.sol";
import "../src/TokenNetwork.sol";
import "../src/TokenNetworkRegistry.sol";

/// @title DeployTestnetCutoverForkTest
/// @notice Runs DeployTestnetCutoverScript against a real Base Sepolia fork (no broadcast, no
///         secrets) so the eventual human broadcast (issue #695) is proven safe ahead of time,
///         the same way DeployMainnet.fork.t.sol proves the mainnet runbook. See issue #694 for
///         the ERC-2771 contract half this deploys.
/// @dev MUST be run with `--fork-url <base-sepolia-rpc>` (e.g. the public
///      https://sepolia.base.org):
///        forge test --match-path 'test/DeployTestnetCutover.fork.t.sol' \
///          --fork-url https://sepolia.base.org -vvv
contract DeployTestnetCutoverForkTest is Test {
    /// @notice The live devnet mock USDC channels must keep settling in
    ///         (packages/contracts/deployments/base-sepolia.md).
    address internal constant EXISTING_USDC = 0x49beE1Bca5d15Fb0963117923403F9498119a9Ce;

    /// @notice The pre-cutover TokenNetworkRegistry -- must stay untouched and keep resolving
    ///         the OLD TokenNetwork for pre-cutover channels (AC: "Channels opened before cutover
    ///         still settle and close against the old deployment").
    address internal constant OLD_REGISTRY = 0xcC9079adE929b168B54145f6d25262b64FAB9D5b;

    /// @notice The pre-cutover TokenNetwork the old registry resolves EXISTING_USDC to.
    address internal constant OLD_TOKEN_NETWORK = 0x1E95493fEF46707E034b4a1945f25a8C76A1823D;

    /// @notice The known-funded devnet USDC distributor (packages/contracts/deployments/
    ///         base-sepolia.md "Deployer / distributor"), impersonated on the fork to fund a
    ///         zero-native-gas test EOA with REAL forked USDC -- no minting, exactly the balance
    ///         story a real agent wallet would have post-cutover.
    address internal constant USDC_DISTRIBUTOR = 0x6bafedaF18FF62f0a63dd0148bafa163204627F6;

    /// @notice run() must not hard-require PRIVATE_KEY -- this whole fork test runs with no key,
    ///         no --broadcast, and no secrets, exactly as CI needs it to.
    function testFork_Cutover_RunsKeylessWithNoBroadcast() public {
        assertEq(vm.envOr("PRIVATE_KEY", uint256(0)), 0, "this test must not have a PRIVATE_KEY available");

        DeployTestnetCutoverScript script = new DeployTestnetCutoverScript();
        (ERC2771Forwarder forwarder, TokenNetworkRegistry registry, TokenNetwork tokenNetwork) = script.run();

        assertGt(address(forwarder).code.length, 0);
        assertGt(address(registry).code.length, 0);
        assertGt(address(tokenNetwork).code.length, 0);
    }

    /// @notice The cutover must produce addresses genuinely distinct from the live pre-cutover
    ///         deployment -- a fresh registry and a fresh TokenNetwork, not a no-op.
    function testFork_Cutover_ProducesFreshAddressesDistinctFromLiveDeployment() public {
        DeployTestnetCutoverScript script = new DeployTestnetCutoverScript();
        (, TokenNetworkRegistry registry, TokenNetwork tokenNetwork) = script.run();

        assertTrue(address(registry) != OLD_REGISTRY, "cutover must deploy a NEW registry, not reuse the live one");
        assertTrue(
            address(tokenNetwork) != OLD_TOKEN_NETWORK, "cutover must deploy a NEW TokenNetwork, not reuse the live one"
        );
    }

    /// @notice The whole point of reusing the registry pattern rather than the token: every
    ///         existing balance and faucet distribution on the live mock USDC must keep working
    ///         after cutover, unchanged.
    function testFork_Cutover_ReusesTheExistingLiveUsdcToken() public {
        DeployTestnetCutoverScript script = new DeployTestnetCutoverScript();
        (,, TokenNetwork tokenNetwork) = script.run();

        assertEq(tokenNetwork.token(), EXISTING_USDC, "the new TokenNetwork must bind the SAME live devnet USDC");
        assertGt(EXISTING_USDC.code.length, 0, "the existing USDC must have real code on the fork");

        IERC20Metadata usdc = IERC20Metadata(EXISTING_USDC);
        assertEq(usdc.symbol(), "USDC");
        assertEq(usdc.decimals(), 6, "devnet USDC is 6 decimals (ADR 0010)");
    }

    /// @notice The new registry resolves the new TokenNetwork for the reused token, and trusts
    ///         the freshly deployed forwarder -- the two facts EvmSettlementBackend::connect and
    ///         a relayer each depend on.
    function testFork_Cutover_RegistryResolvesAndForwarderIsTrusted() public {
        DeployTestnetCutoverScript script = new DeployTestnetCutoverScript();
        (ERC2771Forwarder forwarder, TokenNetworkRegistry registry, TokenNetwork tokenNetwork) = script.run();

        assertEq(registry.getTokenNetwork(EXISTING_USDC), address(tokenNetwork));
        assertTrue(tokenNetwork.isTrustedForwarder(address(forwarder)), "TokenNetwork must trust the new forwarder");
    }

    /// @notice The pre-cutover registry and TokenNetwork are never touched by the cutover -- they
    ///         still have code and the old registry still resolves the old TokenNetwork, so a
    ///         channel opened before cutover keeps settling exactly where it always did.
    function testFork_Cutover_DoesNotDisturbTheOldLiveDeployment() public {
        DeployTestnetCutoverScript script = new DeployTestnetCutoverScript();
        script.run();

        assertGt(OLD_REGISTRY.code.length, 0, "the old registry must still be live");
        assertGt(OLD_TOKEN_NETWORK.code.length, 0, "the old TokenNetwork must still be live");
        assertEq(
            TokenNetworkRegistry(OLD_REGISTRY).getTokenNetwork(EXISTING_USDC),
            OLD_TOKEN_NETWORK,
            "the old registry must still resolve the old TokenNetwork for pre-cutover channels"
        );
    }

    // Shared lifecycle-test context, held in storage rather than as locals -- via_ir hits a
    // Yul "variable N too deep in the stack" limit when this many values (2 keys, 2 signer
    // addresses, a relayer, a channel id, a forwarder/registry/network) are all live as locals
    // across one test function plus its call graph. Storage reads/writes don't consume stack
    // slots the same way, so the lifecycle helpers below read/write these instead of taking
    // long parameter lists.
    ERC2771Forwarder internal lifecycleForwarder;
    TokenNetwork internal lifecycleTokenNetwork;
    address internal lifecycleRelayer;
    address internal lifecycleAlice;
    address internal lifecycleBob;
    uint256 internal lifecycleAlicePrivateKey;
    uint256 internal lifecycleBobPrivateKey;
    bytes32 internal lifecycleChannelId;

    /// @notice End-to-end proof of the acceptance criterion this whole ticket exists for: on the
    ///         REAL forked chain, with REAL forked USDC (funded by impersonating the real
    ///         distributor, not minted), an EOA holding zero native gas opens, deposits into, and
    ///         closes a channel on the NEW post-cutover TokenNetwork entirely through the
    ///         forwarder -- a relayer pays gas, the signer never does.
    function testFork_Cutover_GaslessChannelLifecycleOnRealForkedUsdc() public {
        DeployTestnetCutoverScript script = new DeployTestnetCutoverScript();
        TokenNetworkRegistry registry;
        (lifecycleForwarder, registry, lifecycleTokenNetwork) = script.run();

        lifecycleAlicePrivateKey = 0xA11CE695;
        lifecycleBobPrivateKey = 0xB0B695;
        lifecycleAlice = vm.addr(lifecycleAlicePrivateKey);
        lifecycleBob = vm.addr(lifecycleBobPrivateKey);
        lifecycleRelayer = makeAddr("relayer");
        uint256 depositAmount = 1_000 * 10 ** 6; // 1,000 USDC (6 decimals)

        vm.deal(lifecycleRelayer, 1 ether);
        assertEq(lifecycleAlice.balance, 0, "alice must hold zero native gas throughout");
        assertEq(lifecycleBob.balance, 0, "bob must hold zero native gas throughout");

        // Fund alice with REAL forked USDC by impersonating the real, known-funded distributor --
        // no minting, proving this works against genuine chain state.
        vm.prank(USDC_DISTRIBUTOR);
        IERC20Metadata(EXISTING_USDC).transfer(lifecycleAlice, depositAmount);
        assertEq(IERC20Metadata(EXISTING_USDC).balanceOf(lifecycleAlice), depositAmount);

        _openForwarded();
        _depositForwarded(depositAmount);
        _closeForwarded();

        // Neither participant ever paid gas.
        assertEq(lifecycleAlice.balance, 0, "alice must still hold zero native gas after the full lifecycle");
        assertEq(lifecycleBob.balance, 0, "bob must still hold zero native gas after the full lifecycle");

        // registry/deployment untouched by this exercise.
        assertEq(registry.getTokenNetwork(EXISTING_USDC), address(lifecycleTokenNetwork));
    }

    function _openForwarded() internal {
        bytes memory openData = abi.encodeCall(TokenNetwork.openChannel, (lifecycleBob, 1 hours));
        _executeForwarded(
            lifecycleForwarder,
            lifecycleRelayer,
            lifecycleAlicePrivateKey,
            lifecycleAlice,
            address(lifecycleTokenNetwork),
            openData
        );

        (address p1, address p2) =
            lifecycleAlice < lifecycleBob ? (lifecycleAlice, lifecycleBob) : (lifecycleBob, lifecycleAlice);
        lifecycleChannelId = keccak256(abi.encodePacked(p1, p2, uint256(0)));
        (, TokenNetwork.ChannelState openedState,,, address participant1, address participant2) =
            lifecycleTokenNetwork.channels(lifecycleChannelId);
        assertEq(uint256(openedState), uint256(TokenNetwork.ChannelState.Opened));
        assertTrue(
            (participant1 == lifecycleAlice && participant2 == lifecycleBob)
                || (participant1 == lifecycleBob && participant2 == lifecycleAlice),
            "participants must be alice and bob, never the relayer"
        );
    }

    function _depositForwarded(uint256 depositAmount) internal {
        // The ERC20 approval itself needs no gas-station help to reason about here (it is a
        // direct alice call in the test, exactly like TokenNetworkERC2771.t.sol) -- it is the
        // deposit call to TokenNetwork that must be gasless.
        vm.prank(lifecycleAlice);
        IERC20Metadata(EXISTING_USDC).approve(address(lifecycleTokenNetwork), depositAmount);

        bytes memory depositData =
            abi.encodeCall(TokenNetwork.setTotalDeposit, (lifecycleChannelId, lifecycleAlice, depositAmount));
        _executeForwarded(
            lifecycleForwarder,
            lifecycleRelayer,
            lifecycleAlicePrivateKey,
            lifecycleAlice,
            address(lifecycleTokenNetwork),
            depositData
        );

        (uint256 recordedDeposit,,) = lifecycleTokenNetwork.participants(lifecycleChannelId, lifecycleAlice);
        assertEq(recordedDeposit, depositAmount, "alice's real forked USDC deposit must be recorded");
    }

    function _closeForwarded() internal {
        bytes memory closeData = abi.encodeCall(TokenNetwork.closeChannel, (lifecycleChannelId));
        _executeForwarded(
            lifecycleForwarder,
            lifecycleRelayer,
            lifecycleBobPrivateKey,
            lifecycleBob,
            address(lifecycleTokenNetwork),
            closeData
        );

        (, TokenNetwork.ChannelState closedState,,,,) = lifecycleTokenNetwork.channels(lifecycleChannelId);
        assertEq(uint256(closedState), uint256(TokenNetwork.ChannelState.Closed));
    }

    // ===== Helpers (mirrors test/TokenNetworkERC2771.t.sol's own signing helpers) =====

    bytes32 internal constant FORWARD_REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );

    function _domainSeparator(string memory name, address verifyingContract) internal view returns (bytes32) {
        bytes32 typeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        return keccak256(abi.encode(typeHash, keccak256(bytes(name)), keccak256("1"), block.chainid, verifyingContract));
    }

    function _executeForwarded(
        ERC2771Forwarder forwarder,
        address relayer,
        uint256 signerKey,
        address from,
        address to,
        bytes memory data
    ) internal {
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint256 gas = 500_000;

        bytes32 structHash = keccak256(
            abi.encode(
                FORWARD_REQUEST_TYPEHASH, from, to, uint256(0), gas, forwarder.nonces(from), deadline, keccak256(data)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator("TokenNetworkForwarder", address(forwarder)), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        ERC2771Forwarder.ForwardRequestData memory request = ERC2771Forwarder.ForwardRequestData({
            from: from, to: to, value: 0, gas: gas, deadline: deadline, data: data, signature: abi.encodePacked(r, s, v)
        });

        // The relayer pays gas; the signer's native balance never moves.
        vm.prank(relayer);
        forwarder.execute(request);
    }
}
