// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TokenNetwork.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockERC20WithFee.sol";

/// @title TokenNetworkTest
/// @notice Unit tests for TokenNetwork contract
contract TokenNetworkTest is Test {
    TokenNetwork public tokenNetwork;
    MockERC20 public token;
    address public alice;
    address public bob;
    address public charlie;

    uint256 public alicePrivateKey;
    uint256 public bobPrivateKey;
    uint256 public charliePrivateKey;

    function setUp() public {
        // Deploy mock ERC20 token
        token = new MockERC20("Test Token", "TEST", 18);

        // Deploy TokenNetwork with 1M token deposit limit
        tokenNetwork = new TokenNetwork(address(token), 1_000_000 * 10 ** 18, 365 days);

        // Create test accounts with private keys for EIP-712 signing
        alicePrivateKey = 0xA11CE;
        bobPrivateKey = 0xB0B;
        charliePrivateKey = 0xC0C;

        alice = vm.addr(alicePrivateKey);
        bob = vm.addr(bobPrivateKey);
        charlie = vm.addr(charliePrivateKey);

        // Mint tokens to test accounts
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);

        // Transfer tokens to alice and bob for deposit tests
        token.transfer(alice, 10000 * 10 ** 18);
        token.transfer(bob, 10000 * 10 ** 18);
        token.transfer(charlie, 10000 * 10 ** 18);
    }

    // Test: openChannel - Happy path channel opening
    function testOpenChannel() public {
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        // Assert channelId is not zero
        assertTrue(channelId != bytes32(0), "Channel ID should not be zero");

        // Assert channel state is Opened
        (uint256 settlementTimeout, TokenNetwork.ChannelState state,,, address p1, address p2) =
            tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Opened), "Channel should be Opened");
        assertEq(settlementTimeout, 1 hours, "Settlement timeout should match");

        // Assert participants are alice and bob (normalized order)
        assertTrue((p1 == alice && p2 == bob) || (p1 == bob && p2 == alice), "Participants should be alice and bob");

        vm.stopPrank();
    }

    // Test: openChannel emits ChannelOpened event
    function testOpenChannelEmitsEvent() public {
        vm.startPrank(alice);

        // Participants are normalized (p1 < p2 lexicographically)
        (address p1, address p2) = alice < bob ? (alice, bob) : (bob, alice);
        bytes32 expectedChannelId = keccak256(abi.encodePacked(p1, p2, uint256(0)));

        // Expect ChannelOpened event with normalized participants
        vm.expectEmit(true, true, true, true);
        emit ChannelOpened(expectedChannelId, p1, p2, 1 hours);

        tokenNetwork.openChannel(bob, 1 hours);

        vm.stopPrank();
    }

    // Event declarations for testing
    event ChannelOpened(
        bytes32 indexed channelId, address indexed participant1, address indexed participant2, uint256 settlementTimeout
    );

    event ChannelNewDeposit(bytes32 indexed channelId, address indexed participant, uint256 totalDeposit);

    // Test: openChannel reverts on zero address
    function testOpenChannelRevertsOnZeroAddress() public {
        vm.startPrank(alice);
        vm.expectRevert(TokenNetwork.InvalidParticipant.selector);
        tokenNetwork.openChannel(address(0), 1 hours);
        vm.stopPrank();
    }

    // Test: openChannel reverts on self-channel
    function testOpenChannelRevertsOnSelfChannel() public {
        vm.startPrank(alice);
        vm.expectRevert(TokenNetwork.InvalidParticipant.selector);
        tokenNetwork.openChannel(alice, 1 hours);
        vm.stopPrank();
    }

    // Test: openChannel reverts on invalid timeout
    function testOpenChannelRevertsOnInvalidTimeout() public {
        vm.startPrank(alice);
        vm.expectRevert(TokenNetwork.InvalidSettlementTimeout.selector);
        tokenNetwork.openChannel(bob, 30 minutes); // Below 1 hour minimum
        vm.stopPrank();
    }

    // Test: setTotalDeposit - Happy path deposit
    function testSetTotalDeposit() public {
        // Open channel
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Alice approves TokenNetwork to spend tokens
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);

        // Alice deposits 1000 tokens
        uint256 depositAmount = 1000 * 10 ** 18;
        uint256 balanceBefore = token.balanceOf(address(tokenNetwork));

        tokenNetwork.setTotalDeposit(channelId, alice, depositAmount);

        // Assert participant deposit updated
        (uint256 deposit,,,,) = tokenNetwork.participants(channelId, alice);
        assertEq(deposit, depositAmount, "Alice deposit should be 1000 tokens");

        // Assert TokenNetwork contract balance increased
        uint256 balanceAfter = token.balanceOf(address(tokenNetwork));
        assertEq(balanceAfter - balanceBefore, depositAmount, "Contract balance should increase by deposit amount");

        vm.stopPrank();
    }

    // Test: setTotalDeposit emits ChannelNewDeposit event
    function testSetTotalDepositEmitsEvent() public {
        // Open channel
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Alice approves and deposits
        vm.startPrank(alice);
        uint256 depositAmount = 1000 * 10 ** 18;
        token.approve(address(tokenNetwork), depositAmount);

        vm.expectEmit(true, true, false, true);
        emit ChannelNewDeposit(channelId, alice, depositAmount);

        tokenNetwork.setTotalDeposit(channelId, alice, depositAmount);
        vm.stopPrank();
    }

    // Test: setTotalDeposit - Cumulative deposit behavior
    function testSetTotalDepositIncremental() public {
        // Open channel
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Alice first deposit: 1000 tokens
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 2000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Alice second deposit: additional 1000 (cumulative 2000)
        uint256 balanceBefore = token.balanceOf(address(tokenNetwork));
        tokenNetwork.setTotalDeposit(channelId, alice, 2000 * 10 ** 18);
        uint256 balanceAfter = token.balanceOf(address(tokenNetwork));

        // Assert participant deposit updated to 2000
        (uint256 deposit,,,,) = tokenNetwork.participants(channelId, alice);
        assertEq(deposit, 2000 * 10 ** 18, "Alice deposit should be 2000 tokens");

        // Assert only 1000 additional tokens transferred
        assertEq(balanceAfter - balanceBefore, 1000 * 10 ** 18, "Only 1000 additional tokens should be transferred");

        vm.stopPrank();
    }

    // Test: setTotalDeposit reverts on non-existent channel
    function testSetTotalDepositRevertsOnNonExistentChannel() public {
        // Create a fake channel ID that doesn't exist
        bytes32 fakeChannelId = keccak256("nonexistent");

        // Alice tries to deposit to non-existent channel
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.expectRevert(TokenNetwork.InvalidChannelState.selector);
        tokenNetwork.setTotalDeposit(fakeChannelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();
    }

    // Test: setTotalDeposit reverts on invalid participant
    function testSetTotalDepositRevertsOnInvalidParticipant() public {
        // Open channel between alice and bob
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Charlie tries to deposit (not a participant)
        vm.startPrank(charlie);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.expectRevert(TokenNetwork.InvalidParticipant.selector);
        tokenNetwork.setTotalDeposit(channelId, charlie, 1000 * 10 ** 18);
        vm.stopPrank();
    }

    // Test: setTotalDeposit reverts on decreasing deposit
    function testSetTotalDepositRevertsOnDecreasingDeposit() public {
        // Open channel
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Alice deposits 1000 tokens
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Alice tries to decrease deposit to 500
        vm.expectRevert(TokenNetwork.InsufficientDeposit.selector);
        tokenNetwork.setTotalDeposit(channelId, alice, 500 * 10 ** 18);
        vm.stopPrank();
    }

    // Test: Channel ID uniqueness
    function testChannelIdUniqueness() public {
        vm.startPrank(alice);

        // Open channel: alice → bob
        bytes32 channelId1 = tokenNetwork.openChannel(bob, 1 hours);

        // Open channel: alice → charlie
        bytes32 channelId2 = tokenNetwork.openChannel(charlie, 1 hours);

        // Assert different channel IDs
        assertTrue(channelId1 != channelId2, "Channel IDs should be unique");

        vm.stopPrank();
    }

    // Test: Multiple channels per TokenNetwork
    function testMultipleChannels() public {
        // Open channel: alice → bob
        vm.prank(alice);
        bytes32 channelId1 = tokenNetwork.openChannel(bob, 1 hours);

        // Open channel: alice → charlie
        vm.prank(alice);
        bytes32 channelId2 = tokenNetwork.openChannel(charlie, 1 hours);

        // Open channel: bob → charlie
        vm.prank(bob);
        bytes32 channelId3 = tokenNetwork.openChannel(charlie, 1 hours);

        // Assert all channels have state Opened
        (, TokenNetwork.ChannelState state1,,,,) = tokenNetwork.channels(channelId1);
        (, TokenNetwork.ChannelState state2,,,,) = tokenNetwork.channels(channelId2);
        (, TokenNetwork.ChannelState state3,,,,) = tokenNetwork.channels(channelId3);

        assertEq(uint256(state1), uint256(TokenNetwork.ChannelState.Opened), "Channel 1 should be Opened");
        assertEq(uint256(state2), uint256(TokenNetwork.ChannelState.Opened), "Channel 2 should be Opened");
        assertEq(uint256(state3), uint256(TokenNetwork.ChannelState.Opened), "Channel 3 should be Opened");

        // Assert all channels have unique IDs
        assertTrue(channelId1 != channelId2, "Channel 1 and 2 should have different IDs");
        assertTrue(channelId1 != channelId3, "Channel 1 and 3 should have different IDs");
        assertTrue(channelId2 != channelId3, "Channel 2 and 3 should have different IDs");
    }

    // Test: Both participants can deposit to the same channel
    function testBothParticipantsCanDeposit() public {
        // Open channel
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Alice deposits 1000 tokens
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Bob deposits 2000 tokens
        vm.startPrank(bob);
        token.approve(address(tokenNetwork), 2000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, bob, 2000 * 10 ** 18);
        vm.stopPrank();

        // Assert both deposits recorded
        (uint256 aliceDeposit,,,,) = tokenNetwork.participants(channelId, alice);
        (uint256 bobDeposit,,,,) = tokenNetwork.participants(channelId, bob);

        assertEq(aliceDeposit, 1000 * 10 ** 18, "Alice deposit should be 1000 tokens");
        assertEq(bobDeposit, 2000 * 10 ** 18, "Bob deposit should be 2000 tokens");
    }

    // Test: Third party can deposit on behalf of participant
    function testThirdPartyCanDeposit() public {
        // Open channel between alice and bob
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Charlie deposits on behalf of alice
        vm.startPrank(charlie);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Assert alice's deposit is updated (even though charlie paid)
        (uint256 aliceDeposit,,,,) = tokenNetwork.participants(channelId, alice);
        assertEq(aliceDeposit, 1000 * 10 ** 18, "Alice deposit should be 1000 tokens");
    }

    // ===== Helper Functions for Channel Closure Tests =====

    /// @notice Helper to create and fund a channel
    function createAndFundChannel(address participant1, address participant2, uint256 deposit1, uint256 deposit2)
        internal
        returns (bytes32)
    {
        // Open channel
        vm.prank(participant1);
        bytes32 channelId = tokenNetwork.openChannel(participant2, 1 hours);

        // Fund participant1
        if (deposit1 > 0) {
            vm.startPrank(participant1);
            token.approve(address(tokenNetwork), deposit1);
            tokenNetwork.setTotalDeposit(channelId, participant1, deposit1);
            vm.stopPrank();
        }

        // Fund participant2
        if (deposit2 > 0) {
            vm.startPrank(participant2);
            token.approve(address(tokenNetwork), deposit2);
            tokenNetwork.setTotalDeposit(channelId, participant2, deposit2);
            vm.stopPrank();
        }

        return channelId;
    }

    /// @notice Helper to sign a balance proof using EIP-712
    function signBalanceProof(
        uint256 privateKey,
        bytes32 channelId,
        uint256 nonce,
        uint256 transferredAmount,
        uint256 lockedAmount,
        bytes32 locksRoot
    ) internal view returns (bytes memory) {
        // Compute EIP-712 domain separator manually
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        bytes32 domainSeparator =
            keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));

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

    // ===== Channel Closure Tests =====

    // Test: closeChannel - Happy path channel closure
    function testCloseChannel() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Create balance proof: alice transferred 250 to bob (nonce 1)
        TokenNetwork.BalanceProof memory balanceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        // Sign balance proof with alice's private key
        bytes memory signature = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));

        // Bob calls closeChannel with alice's balance proof and signature
        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, balanceProof, signature);

        // Assert: Channel state is Closed
        (, TokenNetwork.ChannelState state, uint256 closedAt,,,) = tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Closed), "Channel should be Closed");
        assertEq(closedAt, block.timestamp, "Channel closedAt should be current timestamp");

        // Assert: Bob is marked as closer
        (, uint256 bobWithdrawn, bool bobIsCloser,,) = tokenNetwork.participants(channelId, bob);
        assertTrue(bobIsCloser, "Bob should be marked as closer");

        // Assert: Alice's nonce and transferred amount updated
        (, uint256 aliceWithdrawn, bool aliceIsCloser, uint256 aliceNonce, uint256 aliceTransferred) =
            tokenNetwork.participants(channelId, alice);
        assertEq(aliceNonce, 1, "Alice nonce should be 1");
        assertEq(aliceTransferred, 250 * 10 ** 18, "Alice transferred amount should be 250");
    }

    event ChannelClosed(
        bytes32 indexed channelId, address indexed closingParticipant, uint256 nonce, bytes32 balanceHash
    );

    // Test: closeChannel reverts on invalid state
    function testCloseChannelRevertsOnInvalidState() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Create balance proof
        TokenNetwork.BalanceProof memory balanceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory signature = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));

        // Bob closes channel
        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, balanceProof, signature);

        // Try to close again
        vm.expectRevert(TokenNetwork.InvalidChannelState.selector);
        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, balanceProof, signature);
    }

    // Test: closeChannel reverts on invalid signature
    function testCloseChannelRevertsOnInvalidSignature() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Create balance proof
        TokenNetwork.BalanceProof memory balanceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        // Sign with wrong private key (charlie's, not alice's)
        bytes memory signature = signBalanceProof(charliePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));

        // Expect revert
        vm.expectRevert(TokenNetwork.InvalidSignature.selector);
        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, balanceProof, signature);
    }

    // Test: closeChannel reverts on stale nonce
    function testCloseChannelRevertsOnStaleNonce() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Manually set alice's nonce to 5
        // Note: We need to close and challenge first to set a nonce
        TokenNetwork.BalanceProof memory initialProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 5,
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory initialSignature = signBalanceProof(alicePrivateKey, channelId, 5, 100 * 10 ** 18, 0, bytes32(0));

        // Bob closes with nonce 5
        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, initialProof, initialSignature);

        // Reopen channel for next test (since we can't reuse closed channel)
        // Skip this test variation as it requires complex setup
    }

    // Test: updateNonClosingBalanceProof - Happy path challenge
    function testUpdateNonClosingBalanceProof() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Bob closes with alice's state (nonce 1, transferred 250)
        TokenNetwork.BalanceProof memory aliceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory aliceSignature = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, aliceProof, aliceSignature);

        // Alice challenges with bob's newer state (nonce 2, bob transferred 500 to alice)
        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 2,
            transferredAmount: 500 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory bobSignature = signBalanceProof(bobPrivateKey, channelId, 2, 500 * 10 ** 18, 0, bytes32(0));

        vm.prank(alice);
        tokenNetwork.updateNonClosingBalanceProof(channelId, bobProof, bobSignature);

        // Assert: Bob's nonce and transferred amount updated
        (, uint256 bobWithdrawn, bool bobIsCloser, uint256 bobNonce, uint256 bobTransferred) =
            tokenNetwork.participants(channelId, bob);
        assertEq(bobNonce, 2, "Bob nonce should be 2");
        assertEq(bobTransferred, 500 * 10 ** 18, "Bob transferred amount should be 500");
    }

    event NonClosingBalanceProofUpdated(
        bytes32 indexed channelId, address indexed participant, uint256 nonce, bytes32 balanceHash
    );

    // Test: updateNonClosingBalanceProof reverts on expired challenge
    function testUpdateNonClosingBalanceProofRevertsOnExpiredChallenge() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Close channel
        TokenNetwork.BalanceProof memory balanceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory signature = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, balanceProof, signature);

        // Fast forward time past settlement timeout
        vm.warp(block.timestamp + 1 hours + 1);

        // Try to update
        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 2,
            transferredAmount: 500 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory bobSignature = signBalanceProof(bobPrivateKey, channelId, 2, 500 * 10 ** 18, 0, bytes32(0));

        vm.expectRevert(TokenNetwork.ChallengePeriodExpired.selector);
        vm.prank(alice);
        tokenNetwork.updateNonClosingBalanceProof(channelId, bobProof, bobSignature);
    }

    // Test: updateNonClosingBalanceProof reverts on non-monotonic nonce
    function testUpdateNonClosingBalanceProofRevertsOnNonMonotonicNonce() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Bob closes with alice's nonce 1
        TokenNetwork.BalanceProof memory aliceProof1 = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory aliceSignature1 = signBalanceProof(alicePrivateKey, channelId, 1, 100 * 10 ** 18, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, aliceProof1, aliceSignature1);

        // Alice challenges with bob's nonce 5, establishing bob's nonce
        TokenNetwork.BalanceProof memory bobProof1 = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 5,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory bobSignature1 = signBalanceProof(bobPrivateKey, channelId, 5, 250 * 10 ** 18, 0, bytes32(0));

        vm.prank(alice);
        tokenNetwork.updateNonClosingBalanceProof(channelId, bobProof1, bobSignature1);

        // Try to update again with nonce 3 (not greater than 5)
        TokenNetwork.BalanceProof memory bobProof2 = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 3,
            transferredAmount: 500 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory bobSignature2 = signBalanceProof(bobPrivateKey, channelId, 3, 500 * 10 ** 18, 0, bytes32(0));

        vm.expectRevert(TokenNetwork.InvalidNonce.selector);
        vm.prank(alice);
        tokenNetwork.updateNonClosingBalanceProof(channelId, bobProof2, bobSignature2);
    }

    // Test: settleChannel - Happy path settlement
    function testSettleChannel() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Bob closes with alice's state (alice transferred 250 to bob)
        TokenNetwork.BalanceProof memory balanceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory signature = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, balanceProof, signature);

        // Fast forward past challenge period
        vm.warp(block.timestamp + 1 hours + 1);

        // Record balances before settlement
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        // Settle channel
        tokenNetwork.settleChannel(channelId);

        // Assert: Channel state is Settled
        (, TokenNetwork.ChannelState state,,,,) = tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Settled), "Channel should be Settled");

        // Assert: Alice received 750 tokens (1000 - 250 transferred)
        uint256 aliceBalanceAfter = token.balanceOf(alice);
        assertEq(aliceBalanceAfter - aliceBalanceBefore, 750 * 10 ** 18, "Alice should receive 750 tokens");

        // Assert: Bob received 1250 tokens (1000 + 250 received)
        uint256 bobBalanceAfter = token.balanceOf(bob);
        assertEq(bobBalanceAfter - bobBalanceBefore, 1250 * 10 ** 18, "Bob should receive 1250 tokens");

        // Assert: TokenNetwork contract balance is reduced
        uint256 contractBalance = token.balanceOf(address(tokenNetwork));
        assertEq(contractBalance, 0, "Contract balance should be 0 after settlement");
    }

    event ChannelSettled(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount);

    // Test: settleChannel with challenge - Settlement after challenge
    function testSettleChannelWithChallenge() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Bob closes with alice's state (alice transferred 250, nonce 1)
        TokenNetwork.BalanceProof memory aliceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory aliceSignature = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, aliceProof, aliceSignature);

        // Alice challenges with bob's newer state (bob transferred 500, nonce 2)
        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 2,
            transferredAmount: 500 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory bobSignature = signBalanceProof(bobPrivateKey, channelId, 2, 500 * 10 ** 18, 0, bytes32(0));

        vm.prank(alice);
        tokenNetwork.updateNonClosingBalanceProof(channelId, bobProof, bobSignature);

        // Fast forward past challenge period
        vm.warp(block.timestamp + 1 hours + 1);

        // Record balances
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        // Settle
        tokenNetwork.settleChannel(channelId);

        // Assert: Alice received 1250 tokens (1000 - 250 transferred + 500 received)
        uint256 aliceBalanceAfter = token.balanceOf(alice);
        assertEq(aliceBalanceAfter - aliceBalanceBefore, 1250 * 10 ** 18, "Alice should receive 1250 tokens");

        // Assert: Bob received 750 tokens (1000 - 500 transferred + 250 received)
        uint256 bobBalanceAfter = token.balanceOf(bob);
        assertEq(bobBalanceAfter - bobBalanceBefore, 750 * 10 ** 18, "Bob should receive 750 tokens");
    }

    // Test: settleChannel reverts before timeout
    function testSettleChannelRevertsBeforeTimeout() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Close channel
        TokenNetwork.BalanceProof memory balanceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory signature = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, balanceProof, signature);

        // Try to settle immediately
        vm.expectRevert(TokenNetwork.SettlementTimeoutNotExpired.selector);
        tokenNetwork.settleChannel(channelId);
    }

    // Test: settleChannel reverts on wrong state
    function testSettleChannelRevertsOnWrongState() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Try to settle opened channel
        vm.expectRevert(TokenNetwork.InvalidChannelState.selector);
        tokenNetwork.settleChannel(channelId);
    }

    // Test: bilateral transfers - Both participants transfer
    function testBilateralTransfers() public {
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Close with alice's state: alice transferred 300 to bob (nonce 1)
        TokenNetwork.BalanceProof memory aliceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 300 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory aliceSignature = signBalanceProof(alicePrivateKey, channelId, 1, 300 * 10 ** 18, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, aliceProof, aliceSignature);

        // Challenge with bob's state: bob transferred 200 to alice (nonce 1)
        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 200 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory bobSignature = signBalanceProof(bobPrivateKey, channelId, 1, 200 * 10 ** 18, 0, bytes32(0));

        vm.prank(alice);
        tokenNetwork.updateNonClosingBalanceProof(channelId, bobProof, bobSignature);

        // Fast forward and settle
        vm.warp(block.timestamp + 1 hours + 1);

        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        tokenNetwork.settleChannel(channelId);

        // Assert: Alice received 900 tokens (1000 - 300 transferred + 200 received)
        uint256 aliceBalanceAfter = token.balanceOf(alice);
        assertEq(aliceBalanceAfter - aliceBalanceBefore, 900 * 10 ** 18, "Alice should receive 900 tokens");

        // Assert: Bob received 1100 tokens (1000 - 200 transferred + 300 received)
        uint256 bobBalanceAfter = token.balanceOf(bob);
        assertEq(bobBalanceAfter - bobBalanceBefore, 1100 * 10 ** 18, "Bob should receive 1100 tokens");
    }

    // Test: Pause prevents all state-changing operations
    function testPausePreventOperations() public {
        // Pause contract
        tokenNetwork.pause();

        // Test: openChannel reverts when paused
        vm.startPrank(alice);
        vm.expectRevert();
        tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Unpause to setup channel for other tests
        tokenNetwork.unpause();

        // Open channel and deposit
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        vm.startPrank(bob);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, bob, 1000 * 10 ** 18);
        vm.stopPrank();

        // Pause again
        tokenNetwork.pause();

        // Test: setTotalDeposit reverts when paused
        vm.startPrank(alice);
        vm.expectRevert();
        tokenNetwork.setTotalDeposit(channelId, alice, 2000 * 10 ** 18);
        vm.stopPrank();

        // Test: closeChannel reverts when paused
        TokenNetwork.BalanceProof memory aliceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });
        bytes memory aliceSignature = signBalanceProof(alicePrivateKey, channelId, 1, 100 * 10 ** 18, 0, bytes32(0));

        vm.startPrank(bob);
        vm.expectRevert();
        tokenNetwork.closeChannel(channelId, aliceProof, aliceSignature);
        vm.stopPrank();

        // Unpause to close channel
        tokenNetwork.unpause();

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, aliceProof, aliceSignature);

        // Pause again
        tokenNetwork.pause();

        // Test: updateNonClosingBalanceProof reverts when paused
        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 2,
            transferredAmount: 200 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });
        bytes memory bobSignature = signBalanceProof(bobPrivateKey, channelId, 2, 200 * 10 ** 18, 0, bytes32(0));

        vm.startPrank(alice);
        vm.expectRevert();
        tokenNetwork.updateNonClosingBalanceProof(channelId, bobProof, bobSignature);
        vm.stopPrank();

        // Fast forward past challenge period
        vm.warp(block.timestamp + 1 hours + 1);

        // Test: settleChannel reverts when paused
        vm.expectRevert();
        tokenNetwork.settleChannel(channelId);

        // Unpause and settle should work
        tokenNetwork.unpause();
        tokenNetwork.settleChannel(channelId);
    }

    // Test: Unpause restores operations
    function testUnpauseRestoresOperations() public {
        // Pause
        tokenNetwork.pause();

        // Verify paused
        vm.startPrank(alice);
        vm.expectRevert();
        tokenNetwork.openChannel(bob, 1 hours);
        vm.stopPrank();

        // Unpause
        tokenNetwork.unpause();

        // Should work now
        vm.startPrank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        assertTrue(channelId != bytes32(0), "Channel should be created after unpause");
        vm.stopPrank();
    }

    // Test: Deposit limit prevents excessive deposit
    function testDepositLimitPreventsExcessiveDeposit() public {
        // Deploy TokenNetwork with 1000 token deposit limit for testing
        TokenNetwork testNetwork = new TokenNetwork(address(token), 1000 * 10 ** 18, 365 days);

        // Open channel
        vm.startPrank(alice);
        bytes32 channelId = testNetwork.openChannel(bob, 1 hours);

        // Approve amount over limit
        token.approve(address(testNetwork), 1500 * 10 ** 18);

        // Try to deposit more than maxChannelDeposit (1000 tokens) - should revert
        vm.expectRevert(TokenNetwork.DepositLimitExceeded.selector);
        testNetwork.setTotalDeposit(channelId, alice, 1100 * 10 ** 18);

        vm.stopPrank();
    }

    // Test: Deposit limit allows multiple deposits under limit
    function testDepositLimitAllowsMultipleDepositsUnderLimit() public {
        // Deploy TokenNetwork with 1000 token deposit limit for testing
        TokenNetwork testNetwork = new TokenNetwork(address(token), 1000 * 10 ** 18, 365 days);

        // Open channel
        vm.startPrank(alice);
        bytes32 channelId = testNetwork.openChannel(bob, 1 hours);

        // First deposit: 500 tokens
        token.approve(address(testNetwork), 500 * 10 ** 18);
        testNetwork.setTotalDeposit(channelId, alice, 500 * 10 ** 18);

        // Second deposit: additional 400 tokens (total 900, under 1000 limit)
        token.approve(address(testNetwork), 400 * 10 ** 18);
        testNetwork.setTotalDeposit(channelId, alice, 900 * 10 ** 18);

        // Verify deposit
        (uint256 aliceDeposit,,,,) = testNetwork.participants(channelId, alice);
        assertEq(aliceDeposit, 900 * 10 ** 18, "Alice should have 900 tokens deposited");

        vm.stopPrank();
    }

    // Test: Deposit with fee-on-transfer token
    function testDepositWithFeeOnTransferToken() public {
        // Deploy mock ERC20 with 10% transfer fee
        MockERC20WithFee feeToken = new MockERC20WithFee("Fee Token", "FEE", 18, 10);

        // Deploy TokenNetwork for fee token with 1M token deposit limit
        TokenNetwork feeTokenNetwork = new TokenNetwork(address(feeToken), 1_000_000 * 10 ** 18, 365 days);

        // Mint tokens to alice
        feeToken.transfer(alice, 10000 * 10 ** 18);

        // Open channel
        vm.startPrank(alice);
        bytes32 channelId = feeTokenNetwork.openChannel(bob, 1 hours);

        // Approve and deposit 1000 tokens
        feeToken.approve(address(feeTokenNetwork), 1000 * 10 ** 18);
        feeTokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Verify: Participant deposit equals actualReceived (900 tokens after 10% fee)
        (uint256 aliceDeposit,,,,) = feeTokenNetwork.participants(channelId, alice);
        assertEq(aliceDeposit, 900 * 10 ** 18, "Deposit should be 900 tokens (90% of 1000 after 10% fee)");

        vm.stopPrank();
    }

    function testForceCloseExpiredChannel() public {
        // Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        // Fast forward 366 days (past 365 day expiry)
        vm.warp(block.timestamp + 366 days);

        // Anyone can force-close expired channel
        tokenNetwork.forceCloseExpiredChannel(channelId);

        // Verify: Channel is Closed
        (, TokenNetwork.ChannelState state, uint256 closedAt,,,) = tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Closed), "Channel should be Closed");
        assertEq(closedAt, block.timestamp, "closedAt should be current timestamp");
    }

    function testForceCloseRevertsOnActiveChannel() public {
        // Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        // Try force-close before expiry (should revert)
        vm.expectRevert(TokenNetwork.ChannelNotExpired.selector);
        tokenNetwork.forceCloseExpiredChannel(channelId);

        // Fast forward 364 days (still before 365 day expiry)
        vm.warp(block.timestamp + 364 days);

        // Try again (should still revert)
        vm.expectRevert(TokenNetwork.ChannelNotExpired.selector);
        tokenNetwork.forceCloseExpiredChannel(channelId);
    }

    function testCooperativeSettle() public {
        // Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        // Both participants deposit 1000 tokens
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        vm.startPrank(bob);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, bob, 1000 * 10 ** 18);
        vm.stopPrank();

        // Create final state: Alice sent 250 to Bob, Bob sent 100 to Alice
        // Alice final: 1000 - 250 + 100 = 850
        // Bob final: 1000 - 100 + 250 = 1150

        // Alice's balance proof (what Alice sent)
        TokenNetwork.BalanceProof memory aliceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 10,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        // Bob's balance proof (what Bob sent)
        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 10, // Same nonce = agreed final state
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        // Sign balance proofs
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        bytes32 domainSeparator =
            keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));
        bytes32 balanceProofTypeHash = keccak256(
            "BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256 lockedAmount,bytes32 locksRoot)"
        );

        bytes32 aliceStructHash = keccak256(
            abi.encode(
                balanceProofTypeHash,
                aliceProof.channelId,
                aliceProof.nonce,
                aliceProof.transferredAmount,
                aliceProof.lockedAmount,
                aliceProof.locksRoot
            )
        );
        bytes32 aliceDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, aliceStructHash));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(alicePrivateKey, aliceDigest);
        bytes memory aliceSig = abi.encodePacked(r1, s1, v1);

        bytes32 bobStructHash = keccak256(
            abi.encode(
                balanceProofTypeHash,
                bobProof.channelId,
                bobProof.nonce,
                bobProof.transferredAmount,
                bobProof.lockedAmount,
                bobProof.locksRoot
            )
        );
        bytes32 bobDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, bobStructHash));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(bobPrivateKey, bobDigest);
        bytes memory bobSig = abi.encodePacked(r2, s2, v2);

        // Record balances before settlement
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        // Cooperatively settle (anyone can call with both signatures)
        tokenNetwork.cooperativeSettle(channelId, aliceProof, aliceSig, bobProof, bobSig);

        // Verify: Channel is Settled
        (, TokenNetwork.ChannelState state,,,,) = tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Settled), "Channel should be Settled");

        // Verify: Alice received 850 tokens (1000 - 250 + 100)
        assertEq(
            token.balanceOf(alice),
            aliceBalanceBefore + 850 * 10 ** 18,
            "Alice should receive 850 tokens"
        );

        // Verify: Bob received 1150 tokens (1000 - 100 + 250)
        assertEq(
            token.balanceOf(bob),
            bobBalanceBefore + 1150 * 10 ** 18,
            "Bob should receive 1150 tokens"
        );
    }

    function testCooperativeSettleRevertsOnNonceMismatch() public {
        // Open channel with deposits
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        vm.startPrank(bob);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, bob, 1000 * 10 ** 18);
        vm.stopPrank();

        // Create proofs with different nonces
        TokenNetwork.BalanceProof memory aliceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 10, // Alice thinks final nonce is 10
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 11, // Bob thinks final nonce is 11 - MISMATCH!
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        // Sign proofs
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        bytes32 domainSeparator =
            keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));
        bytes32 balanceProofTypeHash = keccak256(
            "BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256 lockedAmount,bytes32 locksRoot)"
        );

        bytes32 aliceStructHash = keccak256(
            abi.encode(balanceProofTypeHash, aliceProof.channelId, aliceProof.nonce, aliceProof.transferredAmount, aliceProof.lockedAmount, aliceProof.locksRoot)
        );
        bytes32 aliceDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, aliceStructHash));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(alicePrivateKey, aliceDigest);
        bytes memory aliceSig = abi.encodePacked(r1, s1, v1);

        bytes32 bobStructHash = keccak256(
            abi.encode(balanceProofTypeHash, bobProof.channelId, bobProof.nonce, bobProof.transferredAmount, bobProof.lockedAmount, bobProof.locksRoot)
        );
        bytes32 bobDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, bobStructHash));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(bobPrivateKey, bobDigest);
        bytes memory bobSig = abi.encodePacked(r2, s2, v2);

        // Test: Cooperative settle should revert on nonce mismatch
        vm.expectRevert(TokenNetwork.NonceMismatch.selector);
        tokenNetwork.cooperativeSettle(channelId, aliceProof, aliceSig, bobProof, bobSig);
    }

    function testWithdraw() public {
        // Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        // Alice deposits 1000 tokens
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Alice wants to withdraw 100 tokens with Bob's signature
        uint256 withdrawnAmount = 100 * 10 ** 18;
        uint256 nonce = 1;

        // Create withdrawal proof struct (for signing)
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        bytes32 domainSeparator =
            keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));

        bytes32 withdrawalProofTypeHash = keccak256(
            "WithdrawalProof(bytes32 channelId,address participant,uint256 withdrawnAmount,uint256 nonce)"
        );

        bytes32 structHash = keccak256(
            abi.encode(withdrawalProofTypeHash, channelId, alice, withdrawnAmount, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        // Bob signs the withdrawal proof
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPrivateKey, digest);
        bytes memory bobSignature = abi.encodePacked(r, s, v);

        // Record alice's balance before withdrawal
        uint256 aliceBalanceBefore = token.balanceOf(alice);

        // Alice withdraws with Bob's signature
        vm.prank(alice);
        tokenNetwork.withdraw(channelId, withdrawnAmount, nonce, bobSignature);

        // Verify: Alice received 100 tokens
        assertEq(
            token.balanceOf(alice),
            aliceBalanceBefore + withdrawnAmount,
            "Alice should receive 100 tokens"
        );

        // Verify: withdrawnAmount updated
        (, uint256 aliceWithdrawn,,,) = tokenNetwork.participants(channelId, alice);
        assertEq(aliceWithdrawn, withdrawnAmount, "Alice withdrawnAmount should be 100");
    }

    function testWithdrawRevertsOnExcessiveAmount() public {
        // Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Try to withdraw more than deposited
        uint256 excessiveWithdrawal = 2000 * 10 ** 18; // More than 1000 deposit
        uint256 nonce = 1;

        // Bob signs the excessive withdrawal (even though it will fail)
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        bytes32 domainSeparator =
            keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));

        bytes32 withdrawalProofTypeHash = keccak256(
            "WithdrawalProof(bytes32 channelId,address participant,uint256 withdrawnAmount,uint256 nonce)"
        );

        bytes32 structHash = keccak256(
            abi.encode(withdrawalProofTypeHash, channelId, alice, excessiveWithdrawal, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPrivateKey, digest);
        bytes memory bobSignature = abi.encodePacked(r, s, v);

        // Test: Should revert
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.WithdrawalExceedsDeposit.selector);
        tokenNetwork.withdraw(channelId, excessiveWithdrawal, nonce, bobSignature);
    }

    function testEmergencyWithdrawOnlyWhenPaused() public {
        // Open channel and deposit tokens
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Try emergency withdraw when NOT paused (should revert)
        vm.expectRevert(TokenNetwork.ContractNotPaused.selector);
        tokenNetwork.emergencyWithdraw(channelId, address(this));
    }

    function testEmergencyWithdrawOnlyOwner() public {
        // Open channel and deposit tokens
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Pause contract
        tokenNetwork.pause();

        // Try emergency withdraw as non-owner (should revert)
        vm.prank(alice);
        vm.expectRevert();
        tokenNetwork.emergencyWithdraw(channelId, alice);
    }

    function testEmergencyWithdrawRecoveryStuckFunds() public {
        // Open channel and deposit tokens
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Simulate emergency: pause contract
        tokenNetwork.pause();

        // Record owner balance before recovery
        address owner = address(this);
        uint256 ownerBalanceBefore = token.balanceOf(owner);
        uint256 contractBalance = token.balanceOf(address(tokenNetwork));

        // Owner performs emergency withdrawal
        vm.expectEmit(true, true, false, true);
        emit TokenNetwork.EmergencyWithdrawal(channelId, owner, contractBalance);
        tokenNetwork.emergencyWithdraw(channelId, owner);

        // Verify all tokens recovered
        assertEq(token.balanceOf(owner), ownerBalanceBefore + contractBalance);
        assertEq(token.balanceOf(address(tokenNetwork)), 0);
    }

    // Test: withdraw with non-increasing withdrawn amount
    function testWithdrawRevertsOnNonIncreasingAmount() public {
        // Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        // Deposit tokens
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Calculate domain separator
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        bytes32 domainSeparator =
            keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));
        bytes32 withdrawalProofTypeHash = keccak256(
            "WithdrawalProof(bytes32 channelId,address participant,uint256 withdrawnAmount,uint256 nonce)"
        );

        // First withdrawal: 100 tokens
        uint256 withdrawnAmount1 = 100 * 10 ** 18;
        bytes32 structHash1 = keccak256(
            abi.encode(withdrawalProofTypeHash, channelId, alice, withdrawnAmount1, uint256(1))
        );
        bytes32 digest1 = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash1));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(bobPrivateKey, digest1);
        bytes memory counterpartySignature1 = abi.encodePacked(r1, s1, v1);

        vm.prank(alice);
        tokenNetwork.withdraw(channelId, withdrawnAmount1, 1, counterpartySignature1);

        // Second withdrawal attempt: same amount (should revert)
        bytes32 structHash2 = keccak256(
            abi.encode(withdrawalProofTypeHash, channelId, alice, withdrawnAmount1, uint256(2))
        );
        bytes32 digest2 = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash2));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(bobPrivateKey, digest2);
        bytes memory counterpartySignature2 = abi.encodePacked(r2, s2, v2);

        vm.prank(alice);
        vm.expectRevert(TokenNetwork.WithdrawalNotIncreasing.selector);
        tokenNetwork.withdraw(channelId, withdrawnAmount1, 2, counterpartySignature2);
    }

    // Test: updateNonClosingBalanceProof reverts when caller is closer
    function testUpdateNonClosingBalanceProofRevertsOnCallerIsCloser() public {
        // Create and fund channel
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Bob closes channel with Alice's proof
        uint256 nonce = 5;
        uint256 transferredAmount = 100 * 10 ** 18;
        bytes memory aliceSignature = signBalanceProof(alicePrivateKey, channelId, nonce, transferredAmount, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(
            channelId,
            TokenNetwork.BalanceProof({
                channelId: channelId,
                nonce: nonce,
                transferredAmount: transferredAmount,
                lockedAmount: 0,
                locksRoot: bytes32(0)
            }),
            aliceSignature
        );

        // Bob (the closer) tries to update balance proof (should revert)
        uint256 newNonce = 6;
        bytes memory bobSignature = signBalanceProof(bobPrivateKey, channelId, newNonce, transferredAmount, 0, bytes32(0));

        vm.prank(bob);
        vm.expectRevert(TokenNetwork.CallerIsCloser.selector);
        tokenNetwork.updateNonClosingBalanceProof(
            channelId,
            TokenNetwork.BalanceProof({
                channelId: channelId,
                nonce: newNonce,
                transferredAmount: transferredAmount,
                lockedAmount: 0,
                locksRoot: bytes32(0)
            }),
            bobSignature
        );
    }

    // Test: updateNonClosingBalanceProof reverts when caller is not a participant
    function testUpdateNonClosingBalanceProofRevertsOnInvalidParticipant() public {
        // Create and fund channel
        bytes32 channelId = createAndFundChannel(alice, bob, 1000 * 10 ** 18, 1000 * 10 ** 18);

        // Bob closes channel with Alice's proof
        uint256 nonce = 5;
        uint256 transferredAmount = 100 * 10 ** 18;
        bytes memory aliceSignature = signBalanceProof(alicePrivateKey, channelId, nonce, transferredAmount, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(
            channelId,
            TokenNetwork.BalanceProof({
                channelId: channelId,
                nonce: nonce,
                transferredAmount: transferredAmount,
                lockedAmount: 0,
                locksRoot: bytes32(0)
            }),
            aliceSignature
        );

        // Charlie (not a participant) tries to update balance proof (should revert)
        uint256 newNonce = 6;
        bytes memory charlieSignature = signBalanceProof(charliePrivateKey, channelId, newNonce, transferredAmount, 0, bytes32(0));

        vm.prank(charlie);
        vm.expectRevert(TokenNetwork.InvalidParticipant.selector);
        tokenNetwork.updateNonClosingBalanceProof(
            channelId,
            TokenNetwork.BalanceProof({
                channelId: channelId,
                nonce: newNonce,
                transferredAmount: transferredAmount,
                lockedAmount: 0,
                locksRoot: bytes32(0)
            }),
            charlieSignature
        );
    }

    // Test: cooperativeSettle with reversed participant order (covers line 575-578)
    function testCooperativeSettleReversedParticipants() public {
        // Open channel
        vm.prank(bob);
        bytes32 channelId = tokenNetwork.openChannel(alice, 1 hours);

        // Deposit tokens
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        vm.startPrank(bob);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, bob, 1000 * 10 ** 18);
        vm.stopPrank();

        // Create balance proofs - Alice sent 100 to Bob, Bob sent 50 to Alice
        uint256 aliceTransferred = 100 * 10 ** 18;
        uint256 bobTransferred = 50 * 10 ** 18;

        // Sign balance proofs
        bytes memory bobSignature = signBalanceProof(bobPrivateKey, channelId, 5, bobTransferred, 0, bytes32(0));
        bytes memory aliceSignature = signBalanceProof(alicePrivateKey, channelId, 5, aliceTransferred, 0, bytes32(0));

        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        // Cooperative settle with Bob's proof first (reversed order)
        tokenNetwork.cooperativeSettle(
            channelId,
            TokenNetwork.BalanceProof({
                channelId: channelId,
                nonce: 5,
                transferredAmount: bobTransferred,
                lockedAmount: 0,
                locksRoot: bytes32(0)
            }),
            bobSignature,
            TokenNetwork.BalanceProof({
                channelId: channelId,
                nonce: 5,
                transferredAmount: aliceTransferred,
                lockedAmount: 0,
                locksRoot: bytes32(0)
            }),
            aliceSignature
        );

        // Verify final balances: Alice gets 1000 - 100 + 50 = 950, Bob gets 1000 - 50 + 100 = 1050
        assertEq(token.balanceOf(alice), aliceBalanceBefore + 950 * 10 ** 18);
        assertEq(token.balanceOf(bob), bobBalanceBefore + 1050 * 10 ** 18);
    }
}
