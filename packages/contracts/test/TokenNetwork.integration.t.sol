// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TokenNetwork.sol";
import "../src/TokenNetworkRegistry.sol";
import "./mocks/MockERC20.sol";

/// @title TokenNetworkIntegrationTest
/// @notice Integration tests for TokenNetwork payment channels
/// @dev Tests multi-channel scenarios, multi-token networks, and full lifecycle flows
contract TokenNetworkIntegrationTest is Test {
    TokenNetworkRegistry public registry;
    TokenNetwork public tokenNetwork;
    MockERC20 public token;

    address public alice;
    address public bob;
    address public charlie;

    uint256 public alicePrivateKey;
    uint256 public bobPrivateKey;
    uint256 public charliePrivateKey;

    function setUp() public {
        // Deploy TokenNetworkRegistry
        registry = new TokenNetworkRegistry();

        // Deploy mock ERC20 token
        token = new MockERC20("Test Token", "TEST", 18);

        // Create TokenNetwork via registry
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));
        tokenNetwork = TokenNetwork(tokenNetworkAddress);

        // Create test accounts with private keys for EIP-712 signing
        alicePrivateKey = 0xA11CE;
        bobPrivateKey = 0xB0B;
        charliePrivateKey = 0xC0C;

        alice = vm.addr(alicePrivateKey);
        bob = vm.addr(bobPrivateKey);
        charlie = vm.addr(charliePrivateKey);

        // Fund test accounts
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);

        // Mint tokens to test accounts
        token.transfer(alice, 100000 * 10 ** 18);
        token.transfer(bob, 100000 * 10 ** 18);
        token.transfer(charlie, 100000 * 10 ** 18);
    }

    /// @notice Integration Test: Multi-channel scenario with 3 participants
    /// @dev Tests concurrent channels: Alice-Bob, Bob-Charlie, Alice-Charlie
    function testIntegration_MultiChannelScenario() public {
        // Scenario: 3 participants (Alice, Bob, Charlie) open 3 channels
        // Alice-Bob, Bob-Charlie, Alice-Charlie
        // Each channel has deposits, transfers, and settles correctly

        // ===== Open 3 Channels =====
        vm.prank(alice);
        bytes32 channelAB = tokenNetwork.openChannel(bob, 1 hours);

        vm.prank(bob);
        bytes32 channelBC = tokenNetwork.openChannel(charlie, 1 hours);

        vm.prank(alice);
        bytes32 channelAC = tokenNetwork.openChannel(charlie, 1 hours);

        // Assert: All channels opened
        assertTrue(channelAB != bytes32(0), "Channel Alice-Bob should be created");
        assertTrue(channelBC != bytes32(0), "Channel Bob-Charlie should be created");
        assertTrue(channelAC != bytes32(0), "Channel Alice-Charlie should be created");

        // ===== Deposit to All Channels =====
        // Channel Alice-Bob: 1000 each
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelAB, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        vm.startPrank(bob);
        token.approve(address(tokenNetwork), 2000 * 10 ** 18); // Bob deposits to 2 channels
        tokenNetwork.setTotalDeposit(channelAB, bob, 1000 * 10 ** 18);
        vm.stopPrank();

        // Channel Bob-Charlie: 1000 each
        vm.startPrank(bob);
        tokenNetwork.setTotalDeposit(channelBC, bob, 1000 * 10 ** 18);
        vm.stopPrank();

        vm.startPrank(charlie);
        token.approve(address(tokenNetwork), 2000 * 10 ** 18); // Charlie deposits to 2 channels
        tokenNetwork.setTotalDeposit(channelBC, charlie, 1000 * 10 ** 18);
        vm.stopPrank();

        // Channel Alice-Charlie: 1000 each
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelAC, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        vm.startPrank(charlie);
        tokenNetwork.setTotalDeposit(channelAC, charlie, 1000 * 10 ** 18);
        vm.stopPrank();

        // ===== Transfer Balance Proofs in All Channels =====
        // Channel Alice-Bob: Alice sends 250 to Bob
        TokenNetwork.BalanceProof memory proofAlice = TokenNetwork.BalanceProof({
            channelId: channelAB,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });
        bytes memory sigAlice = signBalanceProof(alicePrivateKey, channelAB, 1, 250 * 10 ** 18, 0, bytes32(0));

        // Channel Bob-Charlie: Bob sends 500 to Charlie
        TokenNetwork.BalanceProof memory proofBob = TokenNetwork.BalanceProof({
            channelId: channelBC,
            nonce: 1,
            transferredAmount: 500 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });
        bytes memory sigBob = signBalanceProof(bobPrivateKey, channelBC, 1, 500 * 10 ** 18, 0, bytes32(0));

        // Channel Alice-Charlie: Alice sends 100 to Charlie
        TokenNetwork.BalanceProof memory proofAlice2 = TokenNetwork.BalanceProof({
            channelId: channelAC,
            nonce: 1,
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });
        bytes memory sigAlice2 = signBalanceProof(alicePrivateKey, channelAC, 1, 100 * 10 ** 18, 0, bytes32(0));

        // ===== Close All Channels =====
        vm.prank(bob);
        tokenNetwork.closeChannel(channelAB, proofAlice, sigAlice);

        vm.prank(charlie);
        tokenNetwork.closeChannel(channelBC, proofBob, sigBob);

        vm.prank(charlie);
        tokenNetwork.closeChannel(channelAC, proofAlice2, sigAlice2);

        // ===== Wait for Challenge Period =====
        vm.warp(block.timestamp + 1 hours + 1);

        // Record balances before settlement
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);
        uint256 charlieBalanceBefore = token.balanceOf(charlie);

        // ===== Settle All Channels =====
        tokenNetwork.settleChannel(channelAB);
        tokenNetwork.settleChannel(channelBC);
        tokenNetwork.settleChannel(channelAC);

        // ===== Validate Final Balances =====
        // Channel Alice-Bob: Alice deposited 1000, sent 250 → Alice gets 750, Bob gets 1250
        // Channel Bob-Charlie: Bob deposited 1000, sent 500 → Bob gets 500, Charlie gets 1500
        // Channel Alice-Charlie: Alice deposited 1000, sent 100 → Alice gets 900, Charlie gets 1100

        uint256 aliceBalanceAfter = token.balanceOf(alice);
        uint256 bobBalanceAfter = token.balanceOf(bob);
        uint256 charlieBalanceAfter = token.balanceOf(charlie);

        // Alice: +750 (from Alice-Bob) + 900 (from Alice-Charlie) = +1650
        assertEq(aliceBalanceAfter, aliceBalanceBefore + 1650 * 10 ** 18, "Alice balance should increase by 1650");

        // Bob: +1250 (from Alice-Bob) + 500 (from Bob-Charlie) = +1750
        assertEq(bobBalanceAfter, bobBalanceBefore + 1750 * 10 ** 18, "Bob balance should increase by 1750");

        // Charlie: +1500 (from Bob-Charlie) + 1100 (from Alice-Charlie) = +2600
        assertEq(
            charlieBalanceAfter, charlieBalanceBefore + 2600 * 10 ** 18, "Charlie balance should increase by 2600"
        );

        // ===== Validate All Channels Settled =====
        (, TokenNetwork.ChannelState stateAB,,,,) = tokenNetwork.channels(channelAB);
        assertEq(uint256(stateAB), uint256(TokenNetwork.ChannelState.Settled), "Channel Alice-Bob should be Settled");

        (, TokenNetwork.ChannelState stateBC,,,,) = tokenNetwork.channels(channelBC);
        assertEq(
            uint256(stateBC), uint256(TokenNetwork.ChannelState.Settled), "Channel Bob-Charlie should be Settled"
        );

        (, TokenNetwork.ChannelState stateAC,,,,) = tokenNetwork.channels(channelAC);
        assertEq(
            uint256(stateAC), uint256(TokenNetwork.ChannelState.Settled), "Channel Alice-Charlie should be Settled"
        );
    }

    /// @notice Integration Test: Multi-token channels (USDC, DAI, USDT)
    /// @dev Tests TokenNetworkRegistry managing multiple TokenNetworks
    function testIntegration_MultiTokenChannels() public {
        // Deploy 3 tokens: USDC (6 decimals), DAI (18 decimals), USDT (6 decimals)
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 dai = new MockERC20("Dai Stablecoin", "DAI", 18);
        MockERC20 usdt = new MockERC20("Tether", "USDT", 6);

        // Create TokenNetworks via registry
        address tnUSDC = registry.createTokenNetwork(address(usdc));
        address tnDAI = registry.createTokenNetwork(address(dai));
        address tnUSDT = registry.createTokenNetwork(address(usdt));

        // Assert: TokenNetworks created
        assertTrue(tnUSDC != address(0), "USDC TokenNetwork should be created");
        assertTrue(tnDAI != address(0), "DAI TokenNetwork should be created");
        assertTrue(tnUSDT != address(0), "USDT TokenNetwork should be created");

        // Assert: All TokenNetworks different addresses
        assertTrue(tnUSDC != tnDAI && tnDAI != tnUSDT && tnUSDC != tnUSDT, "TokenNetworks should have unique addresses");

        // Assert: Registry mappings correct
        assertEq(registry.getTokenNetwork(address(usdc)), tnUSDC, "USDC TokenNetwork mapping should be correct");
        assertEq(registry.getTokenNetwork(address(dai)), tnDAI, "DAI TokenNetwork mapping should be correct");
        assertEq(registry.getTokenNetwork(address(usdt)), tnUSDT, "USDT TokenNetwork mapping should be correct");

        // Mint tokens to alice and bob
        usdc.transfer(alice, 10000 * 10 ** 6); // 10,000 USDC (6 decimals)
        usdc.transfer(bob, 10000 * 10 ** 6);
        dai.transfer(alice, 10000 * 10 ** 18); // 10,000 DAI (18 decimals)
        dai.transfer(bob, 10000 * 10 ** 18);
        usdt.transfer(alice, 10000 * 10 ** 6); // 10,000 USDT (6 decimals)
        usdt.transfer(bob, 10000 * 10 ** 6);

        // Open channels for all 3 tokens
        vm.prank(alice);
        bytes32 channelUSDC = TokenNetwork(tnUSDC).openChannel(bob, 1 hours);

        vm.prank(alice);
        bytes32 channelDAI = TokenNetwork(tnDAI).openChannel(bob, 1 hours);

        vm.prank(alice);
        bytes32 channelUSDT = TokenNetwork(tnUSDT).openChannel(bob, 1 hours);

        // Deposit to all channels
        vm.startPrank(alice);
        usdc.approve(tnUSDC, 1000 * 10 ** 6);
        TokenNetwork(tnUSDC).setTotalDeposit(channelUSDC, alice, 1000 * 10 ** 6);

        dai.approve(tnDAI, 1000 * 10 ** 18);
        TokenNetwork(tnDAI).setTotalDeposit(channelDAI, alice, 1000 * 10 ** 18);

        usdt.approve(tnUSDT, 1000 * 10 ** 6);
        TokenNetwork(tnUSDT).setTotalDeposit(channelUSDT, alice, 1000 * 10 ** 6);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(tnUSDC, 1000 * 10 ** 6);
        TokenNetwork(tnUSDC).setTotalDeposit(channelUSDC, bob, 1000 * 10 ** 6);

        dai.approve(tnDAI, 1000 * 10 ** 18);
        TokenNetwork(tnDAI).setTotalDeposit(channelDAI, bob, 1000 * 10 ** 18);

        usdt.approve(tnUSDT, 1000 * 10 ** 6);
        TokenNetwork(tnUSDT).setTotalDeposit(channelUSDT, bob, 1000 * 10 ** 6);
        vm.stopPrank();

        // Validate token isolation: USDC channel doesn't affect DAI/USDT channels
        assertEq(usdc.balanceOf(tnUSDC), 2000 * 10 ** 6, "USDC TokenNetwork should hold 2000 USDC");
        assertEq(dai.balanceOf(tnDAI), 2000 * 10 ** 18, "DAI TokenNetwork should hold 2000 DAI");
        assertEq(usdt.balanceOf(tnUSDT), 2000 * 10 ** 6, "USDT TokenNetwork should hold 2000 USDT");

        // Validate all channels opened correctly
        (, TokenNetwork.ChannelState stateUSDC,,,,) = TokenNetwork(tnUSDC).channels(channelUSDC);
        assertEq(uint256(stateUSDC), uint256(TokenNetwork.ChannelState.Opened), "USDC channel should be Opened");

        (, TokenNetwork.ChannelState stateDAI,,,,) = TokenNetwork(tnDAI).channels(channelDAI);
        assertEq(uint256(stateDAI), uint256(TokenNetwork.ChannelState.Opened), "DAI channel should be Opened");

        (, TokenNetwork.ChannelState stateUSDT,,,,) = TokenNetwork(tnUSDT).channels(channelUSDT);
        assertEq(uint256(stateUSDT), uint256(TokenNetwork.ChannelState.Opened), "USDT channel should be Opened");
    }

    /// @notice Integration Test: Full channel lifecycle end-to-end
    /// @dev Tests: open, deposit, transfer, withdraw, cooperative settle
    function testIntegration_ChannelLifecycleEnd2End() public {
        // ===== Open Channel =====
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        (, TokenNetwork.ChannelState state,,,,) = tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Opened), "Channel should be Opened");

        // ===== Deposit =====
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        vm.startPrank(bob);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, bob, 1000 * 10 ** 18);
        vm.stopPrank();

        (uint256 aliceDeposit,,,, uint256 aliceTransferred) = tokenNetwork.participants(channelId, alice);
        assertEq(aliceDeposit, 1000 * 10 ** 18, "Alice deposit should be 1000");

        (uint256 bobDeposit,,,, uint256 bobTransferred) = tokenNetwork.participants(channelId, bob);
        assertEq(bobDeposit, 1000 * 10 ** 18, "Bob deposit should be 1000");

        // ===== Withdraw While Channel Open (Story 8.5 AC8) =====
        // Alice withdraws 100 tokens (requires bob's signature)
        uint256 withdrawnAmount = 100 * 10 ** 18;
        uint256 withdrawNonce = 1;

        bytes32 withdrawalProofTypeHash = keccak256(
            "WithdrawalProof(bytes32 channelId,address participant,uint256 withdrawnAmount,uint256 nonce)"
        );

        bytes32 withdrawHash =
            keccak256(abi.encode(withdrawalProofTypeHash, channelId, alice, withdrawnAmount, withdrawNonce));

        bytes32 domainSeparator = computeDomainSeparator();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, withdrawHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPrivateKey, digest);
        bytes memory bobWithdrawSig = abi.encodePacked(r, s, v);

        uint256 aliceBalanceBefore = token.balanceOf(alice);

        vm.prank(alice);
        tokenNetwork.withdraw(channelId, withdrawnAmount, withdrawNonce, bobWithdrawSig);

        uint256 aliceBalanceAfter = token.balanceOf(alice);
        assertEq(aliceBalanceAfter, aliceBalanceBefore + 100 * 10 ** 18, "Alice should receive 100 tokens");

        // ===== Cooperative Settlement (Story 8.5 AC7) =====
        // Both participants sign final balance proofs
        TokenNetwork.BalanceProof memory aliceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18, // Alice sent 250 to Bob
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 150 * 10 ** 18, // Bob sent 150 to Alice
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory aliceSig = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));
        bytes memory bobSig = signBalanceProof(bobPrivateKey, channelId, 1, 150 * 10 ** 18, 0, bytes32(0));

        uint256 aliceBalanceBeforeSettle = token.balanceOf(alice);
        uint256 bobBalanceBeforeSettle = token.balanceOf(bob);

        // Either participant can call cooperative settle
        vm.prank(alice);
        tokenNetwork.cooperativeSettle(channelId, aliceProof, aliceSig, bobProof, bobSig);

        // Validate channel settled
        (, TokenNetwork.ChannelState finalState,,,,) = tokenNetwork.channels(channelId);
        assertEq(uint256(finalState), uint256(TokenNetwork.ChannelState.Settled), "Channel should be Settled");

        // Validate final balances
        // Alice: deposit 1000, withdrew 100 earlier, transferred 250, received 150
        // Alice net in contract: 1000 - 100 (withdrawn) - 250 (sent) + 150 (received) = 900
        // But she already received the 100 withdrawn, so from settlement she gets: 900 - 100 = 800
        //
        // Bob: deposit 1000, transferred 150, received 250
        // Bob net: 1000 - 150 (sent) + 250 (received) = 1100
        //
        // Total remaining in contract after withdrawal: 1900, distributed as 800 + 1100 = 1900 ✓
        uint256 aliceBalanceAfterSettle = token.balanceOf(alice);
        uint256 bobBalanceAfterSettle = token.balanceOf(bob);

        // Alice should receive 800 tokens from settlement (900 balance - 100 already withdrawn)
        assertEq(
            aliceBalanceAfterSettle,
            aliceBalanceBeforeSettle + 800 * 10 ** 18,
            "Alice should receive 800 tokens (900 balance - 100 already withdrawn)"
        );
        // Bob should receive 1100 tokens from settlement
        assertEq(
            bobBalanceAfterSettle,
            bobBalanceBeforeSettle + 1100 * 10 ** 18,
            "Bob should receive 1100 tokens (1000 deposit - 150 sent + 250 received)"
        );
    }

    // ===== Helper Functions =====

    /// @notice Helper to sign a balance proof using EIP-712
    function signBalanceProof(
        uint256 privateKey,
        bytes32 channelId,
        uint256 nonce,
        uint256 transferredAmount,
        uint256 lockedAmount,
        bytes32 locksRoot
    ) internal view returns (bytes memory) {
        bytes32 domainSeparator = computeDomainSeparator();

        // Compute struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256 lockedAmount,bytes32 locksRoot)"
                ),
                channelId,
                nonce,
                transferredAmount,
                lockedAmount,
                locksRoot
            )
        );

        // Compute digest
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        // Sign digest
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Helper to compute EIP-712 domain separator
    function computeDomainSeparator() internal view returns (bytes32) {
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        return keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));
    }
}
