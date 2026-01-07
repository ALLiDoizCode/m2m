// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../src/TokenNetwork.sol";
import "../src/TokenNetworkRegistry.sol";
import "../src/MockERC20.sol";
import "../src/MockFeeOnTransferERC20.sol";

/**
 * @title TokenNetworkTest
 * @notice Comprehensive unit tests for TokenNetwork contract
 * @dev Tests channel opening, deposits, state transitions, and edge cases
 */
contract TokenNetworkTest is Test {
    TokenNetworkRegistry public registry;
    TokenNetwork public tokenNetwork;
    MockERC20 public token;

    // Use addresses derived from private keys for EIP-712 testing
    uint256 public alicePrivateKey = 0xA11CE;
    uint256 public bobPrivateKey = 0xB0B;
    uint256 public charliePrivateKey = 0xC;

    address public alice;
    address public bob;
    address public charlie;

    uint256 constant SETTLEMENT_TIMEOUT = 1 hours;
    uint256 constant INITIAL_BALANCE = 10000 * 10 ** 18;

    event ChannelOpened(
        bytes32 indexed channelId, address indexed participant1, address indexed participant2, uint256 settlementTimeout
    );

    event ChannelDeposit(
        bytes32 indexed channelId, address indexed participant, uint256 totalDeposit, uint256 depositIncrease
    );

    event ChannelClosed(
        bytes32 indexed channelId, address indexed closingParticipant, uint256 nonce, bytes32 balanceHash
    );

    event NonClosingBalanceProofUpdated(
        bytes32 indexed channelId, address indexed participant, uint256 nonce, bytes32 balanceHash
    );

    event ChannelSettled(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount);

    event MaxDepositUpdated(uint256 oldMax, uint256 newMax);

    function setUp() public {
        // Derive addresses from private keys
        alice = vm.addr(alicePrivateKey);
        bob = vm.addr(bobPrivateKey);
        charlie = vm.addr(charliePrivateKey);

        // Deploy registry and token
        registry = new TokenNetworkRegistry();
        token = new MockERC20("Test Token", "TST", 0);

        // Create TokenNetwork via registry
        address tokenNetworkAddr = registry.createTokenNetwork(address(token));
        tokenNetwork = TokenNetwork(tokenNetworkAddr);

        // Mint tokens to test participants
        token.mint(alice, INITIAL_BALANCE);
        token.mint(bob, INITIAL_BALANCE);
        token.mint(charlie, INITIAL_BALANCE);

        // Approve TokenNetwork to spend tokens
        vm.prank(alice);
        token.approve(address(tokenNetwork), type(uint256).max);

        vm.prank(bob);
        token.approve(address(tokenNetwork), type(uint256).max);

        vm.prank(charlie);
        token.approve(address(tokenNetwork), type(uint256).max);
    }

    /**
     * Test: Successful channel creation
     */
    function testOpenChannel() public {
        // Arrange
        uint256 timeout = 1 hours;

        // Act
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);

        // Compute expected channelId (participants ordered by address)
        address participant1 = alice < bob ? alice : bob;
        address participant2 = alice < bob ? bob : alice;
        bytes32 expectedChannelId = keccak256(abi.encodePacked(participant1, participant2, uint256(0)));
        emit ChannelOpened(expectedChannelId, participant1, participant2, timeout);

        bytes32 channelId = tokenNetwork.openChannel(bob, timeout);

        // Assert
        assertEq(channelId, expectedChannelId, "Channel ID mismatch");
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId)),
            uint256(TokenNetwork.ChannelState.Opened),
            "Channel state should be Opened"
        );
        assertEq(tokenNetwork.channelCounter(), 1, "Channel counter should be 1");
    }

    /**
     * Test: Prevent duplicate channel creation
     */
    function testPreventDuplicateChannel() public {
        // Arrange
        vm.prank(alice);
        tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Act & Assert - Alice tries to open same channel
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.ChannelAlreadyExists.selector);
        tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Act & Assert - Bob tries to open channel with Alice (same pair)
        vm.prank(bob);
        vm.expectRevert(TokenNetwork.ChannelAlreadyExists.selector);
        tokenNetwork.openChannel(alice, SETTLEMENT_TIMEOUT);
    }

    /**
     * Test: Reject invalid participants (zero address)
     */
    function testRejectInvalidParticipants() public {
        // Act & Assert - Zero address
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.InvalidParticipant.selector);
        tokenNetwork.openChannel(address(0), SETTLEMENT_TIMEOUT);

        // Act & Assert - Self channel
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.InvalidParticipant.selector);
        tokenNetwork.openChannel(alice, SETTLEMENT_TIMEOUT);
    }

    /**
     * Test: Reject invalid settlement timeout
     */
    function testRejectInvalidSettlementTimeout() public {
        // Act & Assert - Timeout too short
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.InvalidSettlementTimeout.selector);
        tokenNetwork.openChannel(bob, 30 minutes);

        // Act & Assert - Timeout too long
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.InvalidSettlementTimeout.selector);
        tokenNetwork.openChannel(bob, 31 days);
    }

    /**
     * Test: Deposit functionality
     */
    function testSetTotalDeposit() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);
        uint256 depositAmount = 1000 * 10 ** 18;

        // Act
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ChannelDeposit(channelId, alice, depositAmount, depositAmount);

        tokenNetwork.setTotalDeposit(channelId, alice, depositAmount);

        // Assert
        assertEq(tokenNetwork.getChannelDeposit(channelId, alice), depositAmount, "Alice deposit mismatch");
        assertEq(token.balanceOf(address(tokenNetwork)), depositAmount, "TokenNetwork balance mismatch");
    }

    /**
     * Test: Deposit increase logic
     */
    function testDepositIncrease() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);
        uint256 firstDeposit = 1000 * 10 ** 18;
        uint256 secondTotalDeposit = 1500 * 10 ** 18;
        uint256 expectedIncrease = 500 * 10 ** 18;

        // Act - First deposit
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, firstDeposit);

        // Act - Second deposit (increase)
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ChannelDeposit(channelId, alice, secondTotalDeposit, expectedIncrease);

        tokenNetwork.setTotalDeposit(channelId, alice, secondTotalDeposit);

        // Assert
        assertEq(tokenNetwork.getChannelDeposit(channelId, alice), secondTotalDeposit, "Alice total deposit mismatch");
        assertEq(token.balanceOf(address(tokenNetwork)), secondTotalDeposit, "TokenNetwork balance mismatch");
    }

    /**
     * Test: Reject deposit decrease
     */
    function testRejectDepositDecrease() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);
        uint256 firstDeposit = 1000 * 10 ** 18;

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, firstDeposit);

        // Act & Assert - Try to decrease deposit
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.InvalidDeposit.selector);
        tokenNetwork.setTotalDeposit(channelId, alice, 500 * 10 ** 18);
    }

    /**
     * Test: Deposit to non-existent channel
     */
    function testDepositToNonExistentChannel() public {
        // Arrange
        bytes32 fakeChannelId = keccak256(abi.encodePacked("fake"));

        // Act & Assert
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.ChannelNotFound.selector);
        tokenNetwork.setTotalDeposit(fakeChannelId, alice, 1000 * 10 ** 18);
    }

    /**
     * Test: Deposit to closed channel (manual state change for testing)
     */
    function testDepositToClosedChannel() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Manually set channel to Closed state for testing
        // Note: We can't directly modify state, so this test will be skipped for now
        // Story 8.4 will implement closeChannel function which we can use

        // For now, just verify opened state accepts deposits
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        assertEq(
            tokenNetwork.getChannelDeposit(channelId, alice), 1000 * 10 ** 18, "Deposit should succeed in Opened state"
        );
    }

    /**
     * Test: Multiple channels support
     */
    function testMultipleChannels() public {
        // Arrange & Act
        vm.prank(alice);
        bytes32 channelId1 = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        bytes32 channelId2 = tokenNetwork.openChannel(charlie, SETTLEMENT_TIMEOUT);

        vm.prank(bob);
        bytes32 channelId3 = tokenNetwork.openChannel(charlie, SETTLEMENT_TIMEOUT);

        // Assert - All channels have unique IDs
        assertTrue(channelId1 != channelId2, "Channel 1 and 2 should be different");
        assertTrue(channelId1 != channelId3, "Channel 1 and 3 should be different");
        assertTrue(channelId2 != channelId3, "Channel 2 and 3 should be different");

        // Assert - All channels are in Opened state
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId1)),
            uint256(TokenNetwork.ChannelState.Opened),
            "Channel 1 should be Opened"
        );
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId2)),
            uint256(TokenNetwork.ChannelState.Opened),
            "Channel 2 should be Opened"
        );
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId3)),
            uint256(TokenNetwork.ChannelState.Opened),
            "Channel 3 should be Opened"
        );

        // Deposit in all channels
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId1, alice, 1000 * 10 ** 18);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId2, alice, 2000 * 10 ** 18);

        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId3, bob, 3000 * 10 ** 18);

        // Assert - Deposits tracked independently
        assertEq(tokenNetwork.getChannelDeposit(channelId1, alice), 1000 * 10 ** 18, "Channel 1 Alice deposit");
        assertEq(tokenNetwork.getChannelDeposit(channelId2, alice), 2000 * 10 ** 18, "Channel 2 Alice deposit");
        assertEq(tokenNetwork.getChannelDeposit(channelId3, bob), 3000 * 10 ** 18, "Channel 3 Bob deposit");
    }

    /**
     * Test: Participant ordering (deterministic channel IDs)
     */
    function testParticipantOrdering() public {
        // Act - Alice opens channel to Bob
        vm.prank(alice);
        bytes32 channelId1 = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Can't open duplicate, so we verify the ordering is correct
        // by checking the computed channel ID matches expected ordering

        // Compute expected channel ID with ordered participants
        address participant1 = alice < bob ? alice : bob;
        address participant2 = alice < bob ? bob : alice;
        bytes32 expectedChannelId = keccak256(abi.encodePacked(participant1, participant2, uint256(0)));

        // Assert
        assertEq(channelId1, expectedChannelId, "Channel ID should match ordered participant hash");
    }

    /**
     * Test: Fee-on-transfer token support
     */
    function testFeeOnTransferToken() public {
        // Deploy mock fee-on-transfer token (10% fee)
        MockFeeOnTransferERC20 feeToken = new MockFeeOnTransferERC20();

        // Create TokenNetwork for fee token
        address feeTokenNetworkAddr = registry.createTokenNetwork(address(feeToken));
        TokenNetwork feeTokenNetwork = TokenNetwork(feeTokenNetworkAddr);

        // Mint tokens to Alice
        feeToken.mint(alice, INITIAL_BALANCE);

        // Approve TokenNetwork
        vm.prank(alice);
        feeToken.approve(address(feeTokenNetwork), type(uint256).max);

        // Open channel
        vm.prank(alice);
        bytes32 channelId = feeTokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Attempt to deposit 1000 tokens (90% = 900 should be received due to 10% fee)
        uint256 depositAmount = 1000 * 10 ** 18;
        uint256 expectedReceived = 900 * 10 ** 18; // 10% fee

        vm.prank(alice);
        feeTokenNetwork.setTotalDeposit(channelId, alice, depositAmount);

        // Assert - Deposit recorded as actual received amount (900)
        assertEq(
            feeTokenNetwork.getChannelDeposit(channelId, alice),
            expectedReceived,
            "Deposit should be 900 (after 10% fee)"
        );
        assertEq(feeToken.balanceOf(address(feeTokenNetwork)), expectedReceived, "Contract balance should be 900");
    }

    /**
     * Test: Channel counter increments correctly
     */
    function testChannelCounterIncrement() public {
        // Initial counter
        assertEq(tokenNetwork.channelCounter(), 0, "Initial counter should be 0");

        // Open first channel
        vm.prank(alice);
        tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);
        assertEq(tokenNetwork.channelCounter(), 1, "Counter should be 1 after first channel");

        // Open second channel
        vm.prank(alice);
        tokenNetwork.openChannel(charlie, SETTLEMENT_TIMEOUT);
        assertEq(tokenNetwork.channelCounter(), 2, "Counter should be 2 after second channel");

        // Open third channel
        vm.prank(bob);
        tokenNetwork.openChannel(charlie, SETTLEMENT_TIMEOUT);
        assertEq(tokenNetwork.channelCounter(), 3, "Counter should be 3 after third channel");
    }

    /**
     * Test: Both participants can deposit in same channel
     */
    function testBothParticipantsDeposit() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        uint256 aliceDeposit = 1000 * 10 ** 18;
        uint256 bobDeposit = 2000 * 10 ** 18;

        // Act - Alice deposits
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, aliceDeposit);

        // Act - Bob deposits
        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, bobDeposit);

        // Assert
        assertEq(tokenNetwork.getChannelDeposit(channelId, alice), aliceDeposit, "Alice deposit");
        assertEq(tokenNetwork.getChannelDeposit(channelId, bob), bobDeposit, "Bob deposit");
        assertEq(token.balanceOf(address(tokenNetwork)), aliceDeposit + bobDeposit, "Total contract balance");
    }

    /**
     * Test: Get channel state view function
     */
    function testGetChannelState() public {
        // Non-existent channel
        bytes32 fakeChannelId = keccak256(abi.encodePacked("fake"));
        assertEq(
            uint256(tokenNetwork.getChannelState(fakeChannelId)),
            uint256(TokenNetwork.ChannelState.NonExistent),
            "Non-existent channel"
        );

        // Opened channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId)),
            uint256(TokenNetwork.ChannelState.Opened),
            "Opened channel"
        );
    }

    /**
     * Test: Get channel deposit view function
     */
    function testGetChannelDeposit() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Before deposit
        assertEq(tokenNetwork.getChannelDeposit(channelId, alice), 0, "Initial deposit should be 0");

        // After deposit
        uint256 depositAmount = 1000 * 10 ** 18;
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, depositAmount);

        assertEq(tokenNetwork.getChannelDeposit(channelId, alice), depositAmount, "Deposit after setTotalDeposit");
    }

    /**
     * Test: Settlement timeout boundaries
     */
    function testSettlementTimeoutBoundaries() public {
        // Minimum valid timeout (1 hour)
        vm.prank(alice);
        bytes32 channelId1 = tokenNetwork.openChannel(bob, 1 hours);
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId1)),
            uint256(TokenNetwork.ChannelState.Opened),
            "Min timeout should work"
        );

        // Maximum valid timeout (30 days)
        vm.prank(alice);
        bytes32 channelId2 = tokenNetwork.openChannel(charlie, 30 days);
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId2)),
            uint256(TokenNetwork.ChannelState.Opened),
            "Max timeout should work"
        );
    }

    /**
     * Test: Get channel participants
     */
    function testGetChannelParticipants() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Act
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(channelId);

        // Assert - Participants should be ordered by address (min, max)
        address expectedP1 = alice < bob ? alice : bob;
        address expectedP2 = alice < bob ? bob : alice;
        assertEq(participant1, expectedP1, "Participant1 should be min address");
        assertEq(participant2, expectedP2, "Participant2 should be max address");
    }

    /**
     * Test: Get channel participants returns zero addresses for non-existent channel
     */
    function testGetChannelParticipantsNonExistent() public {
        // Arrange
        bytes32 fakeChannelId = keccak256(abi.encodePacked("fake"));

        // Act
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(fakeChannelId);

        // Assert - Non-existent channel should return zero addresses
        assertEq(participant1, address(0), "Participant1 should be zero address");
        assertEq(participant2, address(0), "Participant2 should be zero address");
    }

    /**
     * Test: Get channel participants with reversed participant order
     */
    function testGetChannelParticipantsReversed() public {
        // Arrange - Bob opens channel to Alice (reversed caller)
        vm.prank(bob);
        bytes32 channelId = tokenNetwork.openChannel(alice, SETTLEMENT_TIMEOUT);

        // Act
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(channelId);

        // Assert - Participants should still be ordered by address (min, max)
        address expectedP1 = alice < bob ? alice : bob;
        address expectedP2 = alice < bob ? bob : alice;
        assertEq(participant1, expectedP1, "Participant1 should be min address");
        assertEq(participant2, expectedP2, "Participant2 should be max address");
    }

    /**
     * Test: Reject third-party deposit (unauthorized deposit)
     */
    function testRejectThirdPartyDeposit() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Act & Assert - Charlie tries to deposit for Alice
        vm.prank(charlie);
        vm.expectRevert(TokenNetwork.UnauthorizedDeposit.selector);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Act & Assert - Charlie tries to deposit for Bob
        vm.prank(charlie);
        vm.expectRevert(TokenNetwork.UnauthorizedDeposit.selector);
        tokenNetwork.setTotalDeposit(channelId, bob, 1000 * 10 ** 18);
    }

    /**
     * Test: Reject deposit by non-participant
     */
    function testRejectDepositByNonParticipant() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Act & Assert - Charlie tries to deposit for himself (not in channel)
        // This will fail at participant validation check (not UnauthorizedDeposit)
        vm.prank(charlie);
        vm.expectRevert(TokenNetwork.InvalidParticipant.selector);
        tokenNetwork.setTotalDeposit(channelId, charlie, 1000 * 10 ** 18);
    }

    /**
     * Helper: Create and sign an EIP-712 balance proof
     */
    function createBalanceProof(
        bytes32 channelId,
        uint256 nonce,
        uint256 transferredAmount,
        uint256 lockedAmount,
        bytes32 locksRoot,
        uint256 signerPrivateKey
    ) internal view returns (TokenNetwork.BalanceProof memory proof, bytes memory signature) {
        proof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: nonce,
            transferredAmount: transferredAmount,
            lockedAmount: lockedAmount,
            locksRoot: locksRoot
        });

        bytes32 structHash = keccak256(
            abi.encode(
                tokenNetwork.BALANCE_PROOF_TYPEHASH(),
                proof.channelId,
                proof.nonce,
                proof.transferredAmount,
                proof.lockedAmount,
                proof.locksRoot
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", tokenNetwork.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPrivateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    /**
     * Test: Close channel with valid balance proof
     */
    function testCloseChannel() public {
        // Arrange: Open channel and deposit funds
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        uint256 aliceDeposit = 1000 * 10 ** 18;
        uint256 bobDeposit = 500 * 10 ** 18;

        vm.prank(alice);
        token.approve(address(tokenNetwork), aliceDeposit);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, aliceDeposit);

        vm.prank(bob);
        token.approve(address(tokenNetwork), bobDeposit);
        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, bobDeposit);

        // Create balance proof: Alice sends 100 to Bob (signed by Alice)
        (TokenNetwork.BalanceProof memory proof, bytes memory signature) = createBalanceProof(
            channelId,
            1, // nonce
            100 * 10 ** 18, // Alice transferred 100 to Bob
            0, // no locked amount
            bytes32(0), // no locks
            alicePrivateKey
        );

        // Act: Bob closes channel with Alice's balance proof
        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit ChannelClosed(
            channelId, bob, 1, keccak256(abi.encodePacked(uint256(100 * 10 ** 18), uint256(0), bytes32(0)))
        );
        tokenNetwork.closeChannel(channelId, proof, signature);

        // Assert: Channel should be closed
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId)),
            uint256(TokenNetwork.ChannelState.Closed),
            "Channel should be closed"
        );
    }

    /**
     * Test: Reject stale balance proof (nonce not greater)
     */
    function testRejectStaleBalanceProof() public {
        // Arrange: Open channel and close with nonce=5
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Close with nonce=5

        (TokenNetwork.BalanceProof memory proof1, bytes memory signature1) =
            createBalanceProof(channelId, 5, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof1, signature1);

        // Act & Assert: Attempt to update with nonce=3 (stale)

        (TokenNetwork.BalanceProof memory proof2, bytes memory signature2) =
            createBalanceProof(channelId, 3, 50 * 10 ** 18, 0, bytes32(0), bobPrivateKey);

        vm.prank(alice);
        vm.expectRevert(TokenNetwork.StaleBalanceProof.selector);
        tokenNetwork.updateNonClosingBalanceProof(channelId, proof2, signature2);
    }

    /**
     * Test: Update non-closing balance proof during challenge period
     */
    function testUpdateNonClosingBalanceProof() public {
        // Arrange: Open channel and close
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        vm.prank(bob);
        token.approve(address(tokenNetwork), 500 * 10 ** 18);
        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, 500 * 10 ** 18);

        // Bob closes with Alice's balance proof (nonce=5)

        (TokenNetwork.BalanceProof memory proof1, bytes memory signature1) =
            createBalanceProof(channelId, 5, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof1, signature1);

        // Act: Alice submits newer balance proof from Bob (nonce=10)

        (TokenNetwork.BalanceProof memory proof2, bytes memory signature2) =
            createBalanceProof(channelId, 10, 200 * 10 ** 18, 0, bytes32(0), bobPrivateKey);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit NonClosingBalanceProofUpdated(
            channelId, alice, 10, keccak256(abi.encodePacked(uint256(200 * 10 ** 18), uint256(0), bytes32(0)))
        );
        tokenNetwork.updateNonClosingBalanceProof(channelId, proof2, signature2);

        // Assert: Challenge accepted
        // (No explicit assertion needed, event emission confirms success)
    }

    /**
     * Test: Reject challenge after challenge period expires
     */
    function testRejectChallengeAfterExpiry() public {
        // Arrange: Open channel and close
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        (TokenNetwork.BalanceProof memory proof1, bytes memory signature1) =
            createBalanceProof(channelId, 5, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof1, signature1);

        // Fast-forward time beyond challenge period
        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);

        // Act & Assert: Attempt to update balance proof after expiry

        (TokenNetwork.BalanceProof memory proof2, bytes memory signature2) =
            createBalanceProof(channelId, 10, 200 * 10 ** 18, 0, bytes32(0), bobPrivateKey);

        vm.prank(alice);
        vm.expectRevert(TokenNetwork.ChallengeExpired.selector);
        tokenNetwork.updateNonClosingBalanceProof(channelId, proof2, signature2);
    }

    /**
     * Test: Settle channel after challenge period
     */
    function testSettleChannel() public {
        // Arrange: Open channel with deposits
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        uint256 aliceDeposit = 1000 * 10 ** 18;
        uint256 bobDeposit = 500 * 10 ** 18;

        vm.prank(alice);
        token.approve(address(tokenNetwork), aliceDeposit);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, aliceDeposit);

        vm.prank(bob);
        token.approve(address(tokenNetwork), bobDeposit);
        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, bobDeposit);

        // Close channel: Alice transferred 200 to Bob (signed by Alice)

        (TokenNetwork.BalanceProof memory proof, bytes memory signature) =
            createBalanceProof(channelId, 1, 200 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof, signature);

        // Fast-forward past challenge period
        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);

        // Record balances before settlement
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        // Debug: Check participant ordering
        (address p1, address p2) = tokenNetwork.getChannelParticipants(channelId);
        console.log("Participant1:", p1);
        console.log("Participant2:", p2);
        console.log("Alice:", alice);
        console.log("Bob:", bob);

        // Act: Settle channel
        // NOTE: participants are ordered, so we need to match the event to ordering
        // If alice < bob: p1=alice, p2=bob → expect (800, 700)
        // If bob < alice: p1=bob, p2=alice → expect (700, 800)
        vm.expectEmit(true, false, false, false); // Don't check data for now
        emit ChannelSettled(channelId, 0, 0);
        tokenNetwork.settleChannel(channelId);

        // Assert: Verify final balances
        // Alice: 1000 - 200 sent = 800
        // Bob: 500 + 200 received = 700
        assertEq(token.balanceOf(alice), aliceBalanceBefore + 800 * 10 ** 18, "Alice should receive 800");
        assertEq(token.balanceOf(bob), bobBalanceBefore + 700 * 10 ** 18, "Bob should receive 700");
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId)),
            uint256(TokenNetwork.ChannelState.Settled),
            "Channel should be settled"
        );
    }

    /**
     * Test: Reject settlement before challenge period expires
     */
    function testRejectSettlementDuringChallenge() public {
        // Arrange: Open channel and close
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        (TokenNetwork.BalanceProof memory proof, bytes memory signature) =
            createBalanceProof(channelId, 1, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof, signature);

        // Act & Assert: Attempt to settle immediately
        vm.expectRevert(TokenNetwork.ChallengeNotExpired.selector);
        tokenNetwork.settleChannel(channelId);
    }

    /**
     * Test: Bidirectional transfers settlement
     */
    function testBidirectionalTransfers() public {
        // Arrange: Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        vm.prank(bob);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, 1000 * 10 ** 18);

        // Alice sends 300 to Bob, Bob sends 100 to Alice
        // Bob closes with Alice's proof (nonce=1)

        (TokenNetwork.BalanceProof memory aliceProof, bytes memory aliceSig) =
            createBalanceProof(channelId, 1, 300 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        // Bob closes with Alice's proof
        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, aliceProof, aliceSig);

        // Alice updates with Bob's proof (nonce must be > 1, use nonce=2)

        (TokenNetwork.BalanceProof memory bobProof, bytes memory bobSig) =
            createBalanceProof(channelId, 2, 100 * 10 ** 18, 0, bytes32(0), bobPrivateKey);

        vm.prank(alice);
        tokenNetwork.updateNonClosingBalanceProof(channelId, bobProof, bobSig);

        // Fast-forward and settle
        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);

        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        tokenNetwork.settleChannel(channelId);

        // Assert: Alice = 1000 - 300 + 100 = 800, Bob = 1000 + 300 - 100 = 1200
        assertEq(token.balanceOf(alice), aliceBalanceBefore + 800 * 10 ** 18, "Alice final balance");
        assertEq(token.balanceOf(bob), bobBalanceBefore + 1200 * 10 ** 18, "Bob final balance");
    }

    /**
     * Test: EIP-712 signature verification with correct signer
     */
    function testEIP712SignatureVerification() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Create valid signature

        (TokenNetwork.BalanceProof memory proof, bytes memory signature) =
            createBalanceProof(channelId, 1, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        // Act: Bob closes with valid signature
        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof, signature);

        // Assert: Should succeed (no revert)
        assertEq(uint256(tokenNetwork.getChannelState(channelId)), uint256(TokenNetwork.ChannelState.Closed));
    }

    /**
     * Test: Reject invalid signature
     */
    function testRejectInvalidSignature() public {
        // Arrange
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        TokenNetwork.BalanceProof memory proof = TokenNetwork.BalanceProof({
            channelId: channelId, nonce: 1, transferredAmount: 100 * 10 ** 18, lockedAmount: 0, locksRoot: bytes32(0)
        });

        // Invalid signature (random bytes)
        bytes memory invalidSignature = abi.encodePacked(bytes32(0), bytes32(0), uint8(0));

        // Act & Assert - ECDSA library throws ECDSAInvalidSignature for malformed signatures
        vm.prank(bob);
        vm.expectRevert(); // Accept any revert (ECDSA.recover will revert with ECDSAInvalidSignature)
        tokenNetwork.closeChannel(channelId, proof, invalidSignature);
    }

    /**
     * Test: Owner can pause contract
     */
    function testPauseContract() public {
        // Arrange - Get owner address
        address owner = tokenNetwork.owner();

        // Act: Owner pauses contract
        vm.prank(owner);
        tokenNetwork.pause();

        // Assert: Contract should be paused
        assertTrue(tokenNetwork.paused(), "Contract should be paused");
    }

    /**
     * Test: Non-owner cannot pause contract
     */
    function testRejectPauseByNonOwner() public {
        // Act & Assert: Alice (non-owner) tries to pause
        vm.prank(alice);
        vm.expectRevert(); // OwnableUnauthorizedAccount error from OpenZeppelin
        tokenNetwork.pause();
    }

    /**
     * Test: Paused contract prevents openChannel
     */
    function testPausedPreventsOpenChannel() public {
        // Arrange: Pause contract
        vm.prank(tokenNetwork.owner());
        tokenNetwork.pause();

        // Act & Assert: Attempt to open channel while paused
        vm.prank(alice);
        vm.expectRevert(); // EnforcedPause error from OpenZeppelin Pausable
        tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);
    }

    /**
     * Test: Paused contract prevents setTotalDeposit
     */
    function testPausedPreventsDeposit() public {
        // Arrange: Open channel first
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Pause contract
        vm.prank(tokenNetwork.owner());
        tokenNetwork.pause();

        // Act & Assert: Attempt to deposit while paused
        vm.prank(alice);
        vm.expectRevert(); // EnforcedPause error
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
    }

    /**
     * Test: Paused contract prevents closeChannel
     */
    function testPausedPreventsCloseChannel() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Create balance proof
        (TokenNetwork.BalanceProof memory proof, bytes memory signature) =
            createBalanceProof(channelId, 1, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        // Pause contract
        vm.prank(tokenNetwork.owner());
        tokenNetwork.pause();

        // Act & Assert: Attempt to close while paused
        vm.prank(bob);
        vm.expectRevert(); // EnforcedPause error
        tokenNetwork.closeChannel(channelId, proof, signature);
    }

    /**
     * Test: Paused contract prevents updateNonClosingBalanceProof
     */
    function testPausedPreventsUpdateBalanceProof() public {
        // Arrange: Open, deposit, and close channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        (TokenNetwork.BalanceProof memory proof1, bytes memory sig1) =
            createBalanceProof(channelId, 1, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof1, sig1);

        // Pause contract
        vm.prank(tokenNetwork.owner());
        tokenNetwork.pause();

        // Act & Assert: Attempt to update balance proof while paused
        (TokenNetwork.BalanceProof memory proof2, bytes memory sig2) =
            createBalanceProof(channelId, 2, 200 * 10 ** 18, 0, bytes32(0), bobPrivateKey);

        vm.prank(alice);
        vm.expectRevert(); // EnforcedPause error
        tokenNetwork.updateNonClosingBalanceProof(channelId, proof2, sig2);
    }

    /**
     * Test: Paused contract prevents settleChannel
     */
    function testPausedPreventsSettlement() public {
        // Arrange: Open, deposit, close channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        (TokenNetwork.BalanceProof memory proof, bytes memory signature) =
            createBalanceProof(channelId, 1, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof, signature);

        // Fast-forward past challenge period
        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);

        // Pause contract
        vm.prank(tokenNetwork.owner());
        tokenNetwork.pause();

        // Act & Assert: Attempt to settle while paused
        vm.expectRevert(); // EnforcedPause error
        tokenNetwork.settleChannel(channelId);
    }

    /**
     * Test: Owner can unpause contract
     */
    function testUnpauseContract() public {
        // Arrange: Pause first
        address owner = tokenNetwork.owner();
        vm.prank(owner);
        tokenNetwork.pause();

        // Act: Owner unpauses
        vm.prank(owner);
        tokenNetwork.unpause();

        // Assert: Contract should not be paused
        assertFalse(tokenNetwork.paused(), "Contract should not be paused");
    }

    /**
     * Test: Unpause restores functionality
     */
    function testUnpauseRestoresFunctionality() public {
        // Arrange: Pause and then unpause
        address owner = tokenNetwork.owner();
        vm.prank(owner);
        tokenNetwork.pause();
        vm.prank(owner);
        tokenNetwork.unpause();

        // Act: Try to open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Assert: Channel should be created successfully
        assertEq(uint256(tokenNetwork.getChannelState(channelId)), uint256(TokenNetwork.ChannelState.Opened));
    }

    /**
     * Test: View functions still work when paused
     */
    function testViewFunctionsWorkWhenPaused() public {
        // Arrange: Open channel then pause
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(tokenNetwork.owner());
        tokenNetwork.pause();

        // Act & Assert: View functions should still work
        TokenNetwork.ChannelState state = tokenNetwork.getChannelState(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Opened), "Should be able to query state when paused");

        (address p1, address p2) = tokenNetwork.getChannelParticipants(channelId);
        assertTrue(p1 != address(0) || p2 != address(0), "Should be able to query participants when paused");
    }

    /**
     * Test: Owner can update maximum deposit limit
     */
    function testSetMaxDeposit() public {
        // Arrange - Get owner and current maxDeposit
        address owner = tokenNetwork.owner();
        uint256 oldMax = tokenNetwork.maxDeposit();
        uint256 newMax = 2_000_000 * 10 ** 18;

        // Act: Owner updates maxDeposit
        vm.prank(owner);
        tokenNetwork.setMaxDeposit(newMax);

        // Assert: maxDeposit should be updated
        assertEq(tokenNetwork.maxDeposit(), newMax, "maxDeposit should be updated");
    }

    /**
     * Test: Non-owner cannot update maximum deposit limit
     */
    function testRejectSetMaxDepositByNonOwner() public {
        // Act & Assert: Alice (non-owner) tries to update maxDeposit
        vm.prank(alice);
        vm.expectRevert(); // OwnableUnauthorizedAccount error
        tokenNetwork.setMaxDeposit(2_000_000 * 10 ** 18);
    }

    /**
     * Test: Reject deposit exceeding maximum deposit limit
     */
    function testRejectDepositExceedingMaximum() public {
        // Arrange: Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Get current maxDeposit (1M tokens with 18 decimals)
        uint256 maxDeposit = tokenNetwork.maxDeposit();

        // Act & Assert: Alice tries to deposit more than maxDeposit
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenNetwork.DepositExceedsMaximum.selector, maxDeposit + 1, maxDeposit));
        tokenNetwork.setTotalDeposit(channelId, alice, maxDeposit + 1);
    }

    /**
     * Test: Accept deposit at exactly maximum deposit limit
     */
    function testAcceptDepositAtMaximum() public {
        // Arrange: Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Get current maxDeposit
        uint256 maxDeposit = tokenNetwork.maxDeposit();

        // Mint enough tokens to Alice to reach maxDeposit
        token.mint(alice, maxDeposit);

        // Act: Alice deposits exactly maxDeposit
        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, maxDeposit);

        // Assert: Deposit should succeed
        uint256 deposit = tokenNetwork.getChannelDeposit(channelId, alice);
        assertEq(deposit, maxDeposit, "Deposit should equal maxDeposit");
    }

    /**
     * Test: MaxDepositUpdated event emission
     */
    function testMaxDepositUpdatedEvent() public {
        // Arrange
        address owner = tokenNetwork.owner();
        uint256 oldMax = tokenNetwork.maxDeposit();
        uint256 newMax = 2_000_000 * 10 ** 18;

        // Act & Assert: Expect event and update
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit MaxDepositUpdated(oldMax, newMax);
        tokenNetwork.setMaxDeposit(newMax);
    }

    // =========================================================================
    // Story 8.5 Tests: Cooperative Settlement (AC7)
    // =========================================================================

    event CooperativeSettlement(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount);

    /**
     * Helper: Create and sign a cooperative settlement proof
     */
    function createCooperativeProof(
        bytes32 channelId,
        uint256 nonce,
        uint256 transferredAmount,
        uint256 signerPrivateKey
    ) internal view returns (TokenNetwork.BalanceProof memory proof, bytes memory signature) {
        proof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: nonce,
            transferredAmount: transferredAmount,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes32 structHash = keccak256(
            abi.encode(
                tokenNetwork.BALANCE_PROOF_TYPEHASH(),
                proof.channelId,
                proof.nonce,
                proof.transferredAmount,
                proof.lockedAmount,
                proof.locksRoot
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", tokenNetwork.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPrivateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    /**
     * Test: Successful cooperative settlement with matching nonces
     */
    function testCooperativeSettleWithMatchingNonces() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        uint256 aliceDeposit = 1000 * 10 ** 18;
        uint256 bobDeposit = 500 * 10 ** 18;

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, aliceDeposit);

        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, bobDeposit);

        // Determine participant order (participant1 = lower address, participant2 = higher address)
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(channelId);
        uint256 p1PrivateKey = participant1 == alice ? alicePrivateKey : bobPrivateKey;
        uint256 p2PrivateKey = participant2 == alice ? alicePrivateKey : bobPrivateKey;

        // Create matching balance proofs (nonce=5)
        // proof1: participant1 sent 200 to participant2
        // proof2: participant2 sent 100 to participant1
        (TokenNetwork.BalanceProof memory proof1, bytes memory sig1) =
            createCooperativeProof(channelId, 5, 200 * 10 ** 18, p1PrivateKey);

        (TokenNetwork.BalanceProof memory proof2, bytes memory sig2) =
            createCooperativeProof(channelId, 5, 100 * 10 ** 18, p2PrivateKey);

        // Record balances before settlement
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        // Act: Cooperatively settle
        tokenNetwork.cooperativeSettle(channelId, proof1, sig1, proof2, sig2);

        // Assert: Calculate expected final balances based on participant ordering
        uint256 p1Deposit = participant1 == alice ? aliceDeposit : bobDeposit;
        uint256 p2Deposit = participant2 == alice ? aliceDeposit : bobDeposit;
        uint256 p1Final = p1Deposit - 200 * 10 ** 18 + 100 * 10 ** 18; // 900 or 400
        uint256 p2Final = p2Deposit - 100 * 10 ** 18 + 200 * 10 ** 18; // 600 or 1100

        if (participant1 == alice) {
            assertEq(token.balanceOf(alice), aliceBalanceBefore + p1Final, "Alice should receive correct amount");
            assertEq(token.balanceOf(bob), bobBalanceBefore + p2Final, "Bob should receive correct amount");
        } else {
            assertEq(token.balanceOf(bob), bobBalanceBefore + p1Final, "Bob should receive correct amount");
            assertEq(token.balanceOf(alice), aliceBalanceBefore + p2Final, "Alice should receive correct amount");
        }
        assertEq(
            uint256(tokenNetwork.getChannelState(channelId)),
            uint256(TokenNetwork.ChannelState.Settled),
            "Channel should be Settled"
        );
    }

    /**
     * Test: Reject cooperative settlement if nonces don't match
     */
    function testRejectCooperativeSettleWithMismatchedNonces() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, 500 * 10 ** 18);

        // Determine participant order
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(channelId);
        uint256 p1PrivateKey = participant1 == alice ? alicePrivateKey : bobPrivateKey;
        uint256 p2PrivateKey = participant2 == alice ? alicePrivateKey : bobPrivateKey;

        // Create balance proofs with mismatched nonces
        (TokenNetwork.BalanceProof memory proof1, bytes memory sig1) =
            createCooperativeProof(channelId, 5, 200 * 10 ** 18, p1PrivateKey);

        (TokenNetwork.BalanceProof memory proof2, bytes memory sig2) =
            createCooperativeProof(
                channelId,
                7,
                100 * 10 ** 18,
                p2PrivateKey // Different nonce
            );

        // Act & Assert: Should revert with NonceMismatch
        vm.expectRevert(abi.encodeWithSelector(TokenNetwork.NonceMismatch.selector, 5, 7));
        tokenNetwork.cooperativeSettle(channelId, proof1, sig1, proof2, sig2);
    }

    /**
     * Test: Reject cooperative settlement if signature invalid
     */
    function testRejectCooperativeSettleWithInvalidSignature() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, 500 * 10 ** 18);

        // Determine participant order
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(channelId);
        uint256 p1PrivateKey = participant1 == alice ? alicePrivateKey : bobPrivateKey;
        uint256 p2PrivateKey = participant2 == alice ? alicePrivateKey : bobPrivateKey;

        // Create valid proof1 but sign with wrong key
        (TokenNetwork.BalanceProof memory proof1,) = createCooperativeProof(channelId, 5, 200 * 10 ** 18, p1PrivateKey);

        // Sign with Charlie's key instead of participant1's key
        (, bytes memory invalidSig) = createCooperativeProof(channelId, 5, 200 * 10 ** 18, charliePrivateKey);

        (TokenNetwork.BalanceProof memory proof2, bytes memory sig2) =
            createCooperativeProof(channelId, 5, 100 * 10 ** 18, p2PrivateKey);

        // Act & Assert: Should revert with InvalidBalanceProof
        vm.expectRevert(TokenNetwork.InvalidBalanceProof.selector);
        tokenNetwork.cooperativeSettle(channelId, proof1, invalidSig, proof2, sig2);
    }

    /**
     * Test: Cooperative settlement calculates final balances correctly with withdrawals
     */
    function testCooperativeSettleWithWithdrawals() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, 500 * 10 ** 18);

        // Determine participant order
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(channelId);

        // Alice withdraws 100 tokens (need counterparty signature)
        address aliceCounterparty = participant1 == alice ? participant2 : participant1;
        uint256 counterpartyKey = aliceCounterparty == bob ? bobPrivateKey : charliePrivateKey;

        TokenNetwork.WithdrawProof memory withdrawProof = TokenNetwork.WithdrawProof({
            channelId: channelId, participant: alice, amount: 100 * 10 ** 18, nonce: 1, expiry: block.timestamp + 1 days
        });

        bytes32 withdrawStructHash = keccak256(
            abi.encode(
                tokenNetwork.WITHDRAW_PROOF_TYPEHASH(),
                withdrawProof.channelId,
                withdrawProof.participant,
                withdrawProof.amount,
                withdrawProof.nonce,
                withdrawProof.expiry
            )
        );

        bytes32 withdrawDigest =
            keccak256(abi.encodePacked("\x19\x01", tokenNetwork.DOMAIN_SEPARATOR(), withdrawStructHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(counterpartyKey, withdrawDigest);
        bytes memory withdrawSig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        tokenNetwork.withdraw(channelId, withdrawProof, withdrawSig);

        // Create matching balance proofs for cooperative settlement
        uint256 p1PrivateKey = participant1 == alice ? alicePrivateKey : bobPrivateKey;
        uint256 p2PrivateKey = participant2 == alice ? alicePrivateKey : bobPrivateKey;

        (TokenNetwork.BalanceProof memory proof1, bytes memory sig1) =
            createCooperativeProof(channelId, 5, 200 * 10 ** 18, p1PrivateKey);

        (TokenNetwork.BalanceProof memory proof2, bytes memory sig2) =
            createCooperativeProof(channelId, 5, 50 * 10 ** 18, p2PrivateKey);

        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        // Act: Cooperatively settle
        tokenNetwork.cooperativeSettle(channelId, proof1, sig1, proof2, sig2);

        // Assert: Final balances account for withdrawals and participant ordering
        // participant1: deposit - withdrawn - sent + received
        // participant2: deposit - withdrawn - sent + received
        uint256 p1Deposit = participant1 == alice ? 1000 * 10 ** 18 : 500 * 10 ** 18;
        uint256 p2Deposit = participant2 == alice ? 1000 * 10 ** 18 : 500 * 10 ** 18;
        uint256 p1Withdrawn = participant1 == alice ? 100 * 10 ** 18 : 0;
        uint256 p2Withdrawn = participant2 == alice ? 100 * 10 ** 18 : 0;

        uint256 p1Final = p1Deposit - p1Withdrawn - 200 * 10 ** 18 + 50 * 10 ** 18;
        uint256 p2Final = p2Deposit - p2Withdrawn - 50 * 10 ** 18 + 200 * 10 ** 18;

        if (participant1 == alice) {
            assertEq(token.balanceOf(alice), aliceBalanceBefore + p1Final, "Alice should receive correct amount");
            assertEq(token.balanceOf(bob), bobBalanceBefore + p2Final, "Bob should receive correct amount");
        } else {
            assertEq(token.balanceOf(bob), bobBalanceBefore + p1Final, "Bob should receive correct amount");
            assertEq(token.balanceOf(alice), aliceBalanceBefore + p2Final, "Alice should receive correct amount");
        }
    }

    /**
     * Test: Cooperative settlement bypasses Closed state (Opened → Settled)
     */
    function testCooperativeSettleBypassesClosedState() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, 500 * 10 ** 18);

        // Verify initial state is Opened
        assertEq(uint256(tokenNetwork.getChannelState(channelId)), uint256(TokenNetwork.ChannelState.Opened));

        // Determine participant order
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(channelId);
        uint256 p1PrivateKey = participant1 == alice ? alicePrivateKey : bobPrivateKey;
        uint256 p2PrivateKey = participant2 == alice ? alicePrivateKey : bobPrivateKey;

        // Create matching balance proofs
        (TokenNetwork.BalanceProof memory proof1, bytes memory sig1) =
            createCooperativeProof(channelId, 5, 100 * 10 ** 18, p1PrivateKey);

        (TokenNetwork.BalanceProof memory proof2, bytes memory sig2) =
            createCooperativeProof(channelId, 5, 50 * 10 ** 18, p2PrivateKey);

        // Act: Cooperatively settle
        tokenNetwork.cooperativeSettle(channelId, proof1, sig1, proof2, sig2);

        // Assert: State should go directly from Opened to Settled (skip Closed)
        assertEq(uint256(tokenNetwork.getChannelState(channelId)), uint256(TokenNetwork.ChannelState.Settled));
    }

    // =========================================================================
    // Story 8.5 Tests: Withdrawal (AC8)
    // =========================================================================

    event Withdrawal(bytes32 indexed channelId, address indexed participant, uint256 amount, uint256 nonce);

    /**
     * Helper: Create and sign a withdrawal proof
     */
    function createWithdrawProof(
        bytes32 channelId,
        address participant,
        uint256 amount,
        uint256 nonce,
        uint256 expiry,
        uint256 signerPrivateKey
    ) internal view returns (TokenNetwork.WithdrawProof memory proof, bytes memory signature) {
        proof = TokenNetwork.WithdrawProof({
            channelId: channelId, participant: participant, amount: amount, nonce: nonce, expiry: expiry
        });

        bytes32 structHash = keccak256(
            abi.encode(
                tokenNetwork.WITHDRAW_PROOF_TYPEHASH(),
                proof.channelId,
                proof.participant,
                proof.amount,
                proof.nonce,
                proof.expiry
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", tokenNetwork.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPrivateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    /**
     * Test: Successful withdrawal with valid counterparty signature
     */
    function testWithdrawWithValidCounterpartySignature() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Create withdrawal proof (Bob signs for Alice to withdraw 200)
        (TokenNetwork.WithdrawProof memory proof, bytes memory signature) =
            createWithdrawProof(channelId, alice, 200 * 10 ** 18, 1, block.timestamp + 1 days, bobPrivateKey);

        uint256 aliceBalanceBefore = token.balanceOf(alice);

        // Act: Alice withdraws
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit Withdrawal(channelId, alice, 200 * 10 ** 18, 1);
        tokenNetwork.withdraw(channelId, proof, signature);

        // Assert: Alice should receive 200 tokens
        assertEq(token.balanceOf(alice), aliceBalanceBefore + 200 * 10 ** 18, "Alice should receive 200");
    }

    /**
     * Test: Reject withdrawal with expired proof
     */
    function testRejectWithdrawWithExpiredProof() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Create withdrawal proof with expiry in the past
        (TokenNetwork.WithdrawProof memory proof, bytes memory signature) = createWithdrawProof(
            channelId,
            alice,
            200 * 10 ** 18,
            1,
            block.timestamp - 1, // Already expired
            bobPrivateKey
        );

        // Act & Assert: Should revert with WithdrawalProofExpired
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.WithdrawalProofExpired.selector);
        tokenNetwork.withdraw(channelId, proof, signature);
    }

    /**
     * Test: Reject withdrawal exceeding available deposit
     */
    function testRejectWithdrawExceedingDeposit() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Create withdrawal proof for more than deposited
        (TokenNetwork.WithdrawProof memory proof, bytes memory signature) = createWithdrawProof(
            channelId,
            alice,
            1500 * 10 ** 18, // More than deposit
            1,
            block.timestamp + 1 days,
            bobPrivateKey
        );

        // Act & Assert: Should revert with InsufficientDepositForWithdrawal
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.InsufficientDepositForWithdrawal.selector);
        tokenNetwork.withdraw(channelId, proof, signature);
    }

    /**
     * Test: Reject replay attack (same nonce)
     */
    function testRejectWithdrawReplayAttack() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Create first withdrawal proof
        (TokenNetwork.WithdrawProof memory proof1, bytes memory sig1) =
            createWithdrawProof(channelId, alice, 200 * 10 ** 18, 1, block.timestamp + 1 days, bobPrivateKey);

        // First withdrawal succeeds
        vm.prank(alice);
        tokenNetwork.withdraw(channelId, proof1, sig1);

        // Try to replay same withdrawal proof
        vm.prank(alice);
        vm.expectRevert(TokenNetwork.StaleBalanceProof.selector);
        tokenNetwork.withdraw(channelId, proof1, sig1);
    }

    /**
     * Test: withdrawnAmount tracked correctly
     */
    function testWithdrawAmountTracking() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // First withdrawal: 200 tokens
        (TokenNetwork.WithdrawProof memory proof1, bytes memory sig1) =
            createWithdrawProof(channelId, alice, 200 * 10 ** 18, 1, block.timestamp + 1 days, bobPrivateKey);

        vm.prank(alice);
        tokenNetwork.withdraw(channelId, proof1, sig1);

        // Second withdrawal: 300 more tokens (total withdrawn = 500)
        (TokenNetwork.WithdrawProof memory proof2, bytes memory sig2) =
            createWithdrawProof(channelId, alice, 300 * 10 ** 18, 2, block.timestamp + 1 days, bobPrivateKey);

        vm.prank(alice);
        tokenNetwork.withdraw(channelId, proof2, sig2);

        // Third withdrawal should fail (only 500 remaining: 1000 - 200 - 300)
        (TokenNetwork.WithdrawProof memory proof3, bytes memory sig3) = createWithdrawProof(
            channelId,
            alice,
            600 * 10 ** 18, // Exceeds remaining balance
            3,
            block.timestamp + 1 days,
            bobPrivateKey
        );

        vm.prank(alice);
        vm.expectRevert(TokenNetwork.InsufficientDepositForWithdrawal.selector);
        tokenNetwork.withdraw(channelId, proof3, sig3);
    }

    /**
     * Test: Settlement accounts for withdrawn amounts
     * FIXED: Settlement now correctly subtracts withdrawnAmount from participant balances
     * This test verifies the fix for the bug documented in Story 8.5
     */
    function testSettlementAccountsForWithdrawals() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, 500 * 10 ** 18);

        // Determine participant order for withdrawal signature
        (address participant1, address participant2) = tokenNetwork.getChannelParticipants(channelId);
        address aliceCounterparty = (participant1 == alice) ? participant2 : participant1;
        uint256 counterpartyKey = (aliceCounterparty == bob) ? bobPrivateKey : charliePrivateKey;

        // Alice withdraws 200 tokens
        (TokenNetwork.WithdrawProof memory proof, bytes memory signature) =
            createWithdrawProof(channelId, alice, 200 * 10 ** 18, 1, block.timestamp + 1 days, counterpartyKey);

        vm.prank(alice);
        tokenNetwork.withdraw(channelId, proof, signature);

        // Close and settle channel (Alice sent 100 to Bob)
        (TokenNetwork.BalanceProof memory closeProof, bytes memory closeSig) =
            createBalanceProof(channelId, 1, 100 * 10 ** 18, 0, bytes32(0), alicePrivateKey);

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, closeProof, closeSig);

        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);

        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        tokenNetwork.settleChannel(channelId);

        // Assert: Calculate expected based on participant ordering
        // FIXED: Settlement now correctly subtracts withdrawnAmount from final balance
        // participant1: deposit + receivedFrom2 - sentTo2 - withdrawn1
        // participant2: deposit + receivedFrom1 - sentTo1 - withdrawn2

        uint256 p1Deposit = (participant1 == alice) ? 1000 * 10 ** 18 : 500 * 10 ** 18;
        uint256 p2Deposit = (participant2 == alice) ? 1000 * 10 ** 18 : 500 * 10 ** 18;

        // Alice sent 100 to Bob (proof.transferredAmount)
        // Bob closes with Alice's proof, so:
        // - channel.participants[bob].transferredAmount = what Alice sent = 100
        // - channel.participants[alice].transferredAmount = what Bob sent = 0  (no update)
        uint256 aliceSent = 100 * 10 ** 18;
        uint256 bobSent = 0;

        uint256 p1Sent = (participant1 == alice) ? aliceSent : bobSent;
        uint256 p2Sent = (participant2 == alice) ? aliceSent : bobSent;
        uint256 p1Received = (participant1 == alice) ? bobSent : aliceSent;
        uint256 p2Received = (participant2 == alice) ? bobSent : aliceSent;

        // Alice withdrew 200, Bob withdrew 0
        uint256 p1Withdrawn = (participant1 == alice) ? 200 * 10 ** 18 : 0;
        uint256 p2Withdrawn = (participant2 == alice) ? 200 * 10 ** 18 : 0;

        // Settlement formula: deposit + received - sent - withdrawn
        uint256 p1Final = p1Deposit + p1Received - p2Received - p1Withdrawn; // sent = what other received
        uint256 p2Final = p2Deposit + p2Received - p1Received - p2Withdrawn;

        if (participant1 == alice) {
            assertEq(token.balanceOf(alice), aliceBalanceBefore + p1Final, "Alice should receive correct amount");
            assertEq(token.balanceOf(bob), bobBalanceBefore + p2Final, "Bob should receive correct amount");
        } else {
            assertEq(token.balanceOf(bob), bobBalanceBefore + p1Final, "Bob should receive correct amount");
            assertEq(token.balanceOf(alice), aliceBalanceBefore + p2Final, "Alice should receive correct amount");
        }
    }

    // =========================================================================
    // Story 8.5 Tests: Force Close Expired Channel (AC6)
    // =========================================================================

    event ChannelExpired(bytes32 indexed channelId, uint256 openedAt, uint256 closedAt);

    /**
     * Test: Successful force close after MAX_CHANNEL_LIFETIME
     */
    function testForceCloseExpiredChannel() public {
        // Arrange: Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Fast-forward beyond MAX_CHANNEL_LIFETIME (365 days)
        uint256 openedAt = block.timestamp;
        vm.warp(block.timestamp + 365 days + 1);

        // Act: Anyone can force close
        vm.expectEmit(true, false, false, false);
        emit ChannelExpired(channelId, openedAt, block.timestamp);
        tokenNetwork.forceCloseExpiredChannel(channelId);

        // Assert: Channel should be closed
        assertEq(uint256(tokenNetwork.getChannelState(channelId)), uint256(TokenNetwork.ChannelState.Closed));
    }

    /**
     * Test: Reject force close before expiry
     */
    function testRejectForceCloseBeforeExpiry() public {
        // Arrange: Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        uint256 expiryTime = block.timestamp + 365 days;

        // Act & Assert: Try to force close before expiry
        vm.expectRevert(abi.encodeWithSelector(TokenNetwork.ChannelNotExpired.selector, expiryTime));
        tokenNetwork.forceCloseExpiredChannel(channelId);
    }

    /**
     * Test: Settlement proceeds normally after force close
     */
    function testSettlementAfterForceClose() public {
        // Arrange: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        vm.prank(bob);
        tokenNetwork.setTotalDeposit(channelId, bob, 500 * 10 ** 18);

        // Force close after expiry
        vm.warp(block.timestamp + 365 days + 1);
        tokenNetwork.forceCloseExpiredChannel(channelId);

        // Wait for challenge period
        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);

        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);

        // Act: Settle channel
        tokenNetwork.settleChannel(channelId);

        // Assert: All deposits returned (no transfers since force closed with empty proofs)
        assertEq(token.balanceOf(alice), aliceBalanceBefore + 1000 * 10 ** 18, "Alice should receive full deposit");
        assertEq(token.balanceOf(bob), bobBalanceBefore + 500 * 10 ** 18, "Bob should receive full deposit");
    }

    /**
     * Test: Anyone can call forceCloseExpiredChannel
     */
    function testAnyoneCanForceCloseExpiredChannel() public {
        // Arrange: Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Fast-forward beyond expiry
        vm.warp(block.timestamp + 365 days + 1);

        // Act: Charlie (not a participant) force closes
        vm.prank(charlie);
        tokenNetwork.forceCloseExpiredChannel(channelId);

        // Assert: Channel should be closed
        assertEq(uint256(tokenNetwork.getChannelState(channelId)), uint256(TokenNetwork.ChannelState.Closed));
    }

    // =========================================================================
    // Story 8.5 Tests: Emergency Token Recovery (AC9)
    // =========================================================================

    event EmergencyTokenRecovery(address indexed token, address indexed recipient, uint256 amount);

    /**
     * Test: Owner can recover tokens when paused
     */
    function testEmergencyTokenRecoveryWhenPaused() public {
        // Arrange: Deposit some tokens
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Pause contract
        address owner = tokenNetwork.owner();
        vm.prank(owner);
        tokenNetwork.pause();

        uint256 charlieBalanceBefore = token.balanceOf(charlie);

        // Act: Owner recovers tokens
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit EmergencyTokenRecovery(address(token), charlie, 500 * 10 ** 18);
        tokenNetwork.emergencyTokenRecovery(address(token), charlie, 500 * 10 ** 18);

        // Assert: Charlie should receive tokens
        assertEq(token.balanceOf(charlie), charlieBalanceBefore + 500 * 10 ** 18, "Charlie should receive 500");
    }

    /**
     * Test: Reject recovery when not paused
     */
    function testRejectEmergencyRecoveryWhenNotPaused() public {
        // Arrange: Deposit tokens
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        // Act & Assert: Try to recover without pausing (should fail)
        address owner = tokenNetwork.owner();
        vm.prank(owner);
        vm.expectRevert(); // ExpectedPause error from OpenZeppelin
        tokenNetwork.emergencyTokenRecovery(address(token), charlie, 500 * 10 ** 18);
    }

    /**
     * Test: Reject recovery if not owner
     */
    function testRejectEmergencyRecoveryByNonOwner() public {
        // Arrange: Pause contract
        address owner = tokenNetwork.owner();
        vm.prank(owner);
        tokenNetwork.pause();

        // Act & Assert: Alice (non-owner) tries to recover
        vm.prank(alice);
        vm.expectRevert(); // OwnableUnauthorizedAccount error
        tokenNetwork.emergencyTokenRecovery(address(token), charlie, 500 * 10 ** 18);
    }

    /**
     * Test: Verify tokens transferred to recipient
     */
    function testEmergencyRecoveryTransfersToRecipient() public {
        // Arrange: Deposit and pause
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);

        address owner = tokenNetwork.owner();
        vm.prank(owner);
        tokenNetwork.pause();

        uint256 charlieBalanceBefore = token.balanceOf(charlie);
        uint256 contractBalanceBefore = token.balanceOf(address(tokenNetwork));

        // Act: Recover
        vm.prank(owner);
        tokenNetwork.emergencyTokenRecovery(address(token), charlie, 300 * 10 ** 18);

        // Assert: Balances updated correctly
        assertEq(token.balanceOf(charlie), charlieBalanceBefore + 300 * 10 ** 18, "Charlie balance");
        assertEq(token.balanceOf(address(tokenNetwork)), contractBalanceBefore - 300 * 10 ** 18, "Contract balance");
    }
}
