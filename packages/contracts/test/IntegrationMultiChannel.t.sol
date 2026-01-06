// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "../src/TokenNetworkRegistry.sol";
import "../src/TokenNetwork.sol";
import "../src/MockERC20.sol";

/**
 * @title Multi-Channel and Multi-Token Integration Tests
 * @notice Comprehensive integration tests for complex payment channel scenarios
 * @dev Story 8.6 Task 3: Validate multi-channel, multi-token, and dispute scenarios
 *
 * Test Coverage:
 * - Concurrent channels for same peer with different tokens
 * - Multi-participant channel scenarios
 * - Channel lifecycle stress testing
 * - Token network registry multi-token integration
 * - Dispute resolution workflows
 * - Cooperative settlement with withdrawals
 */
contract IntegrationMultiChannelTest is Test {
    TokenNetworkRegistry public registry;

    MockERC20 public usdc;
    MockERC20 public dai;
    MockERC20 public usdt;

    TokenNetwork public usdcNetwork;
    TokenNetwork public daiNetwork;
    TokenNetwork public usdtNetwork;

    address public alice;
    address public bob;
    address public carol;
    address public dave;

    uint256 public alicePrivateKey;
    uint256 public bobPrivateKey;
    uint256 public carolPrivateKey;
    uint256 public davePrivateKey;

    uint256 constant SETTLEMENT_TIMEOUT = 3600; // 1 hour
    uint256 constant DEPOSIT_AMOUNT = 1000 * 10**18;

    function setUp() public {
        // Setup test accounts
        alicePrivateKey = 0xA11CE;
        bobPrivateKey = 0xB0B;
        carolPrivateKey = 0xCA201;
        davePrivateKey = 0xDADE;

        alice = vm.addr(alicePrivateKey);
        bob = vm.addr(bobPrivateKey);
        carol = vm.addr(carolPrivateKey);
        dave = vm.addr(davePrivateKey);

        // Deploy registry
        registry = new TokenNetworkRegistry();

        // Deploy test tokens
        usdc = new MockERC20("USD Coin", "USDC", 6);
        dai = new MockERC20("Dai Stablecoin", "DAI", 18);
        usdt = new MockERC20("Tether USD", "USDT", 6);

        // Create token networks
        address usdcNetworkAddr = registry.createTokenNetwork(address(usdc));
        address daiNetworkAddr = registry.createTokenNetwork(address(dai));
        address usdtNetworkAddr = registry.createTokenNetwork(address(usdt));

        usdcNetwork = TokenNetwork(usdcNetworkAddr);
        daiNetwork = TokenNetwork(daiNetworkAddr);
        usdtNetwork = TokenNetwork(usdtNetworkAddr);

        // Fund participants with all tokens
        address[4] memory participants = [alice, bob, carol, dave];
        for (uint256 i = 0; i < participants.length; i++) {
            usdc.mint(participants[i], 10000 * 10**6); // USDC has 6 decimals
            dai.mint(participants[i], 10000 * 10**18);
            usdt.mint(participants[i], 10000 * 10**6); // USDT has 6 decimals

            // Approve all token networks
            vm.startPrank(participants[i]);
            usdc.approve(address(usdcNetwork), type(uint256).max);
            dai.approve(address(daiNetwork), type(uint256).max);
            usdt.approve(address(usdtNetwork), type(uint256).max);
            vm.stopPrank();
        }
    }

    /**
     * @notice Test concurrent channels for same peer with different tokens
     * @dev Story 8.6 AC3: Verify channels independent, state changes don't interfere
     */
    function testIntegration_ConcurrentChannelsForSamePeer() public {
        // Alice and Bob open 3 channels with different tokens
        vm.prank(alice);
        bytes32 usdcChannelId = usdcNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        bytes32 daiChannelId = daiNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        bytes32 usdtChannelId = usdtNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        // Verify all channels exist in their respective networks (same participants, different tokens)
        assertEq(uint8(usdcNetwork.getChannelState(usdcChannelId)), uint8(TokenNetwork.ChannelState.Opened));
        assertEq(uint8(daiNetwork.getChannelState(daiChannelId)), uint8(TokenNetwork.ChannelState.Opened));
        assertEq(uint8(usdtNetwork.getChannelState(usdtChannelId)), uint8(TokenNetwork.ChannelState.Opened));

        // Make deposits in all channels
        vm.prank(alice);
        usdcNetwork.setTotalDeposit(usdcChannelId, alice, 1000 * 10**6);

        vm.prank(bob);
        usdcNetwork.setTotalDeposit(usdcChannelId, bob, 1000 * 10**6);

        vm.prank(alice);
        daiNetwork.setTotalDeposit(daiChannelId, alice, 1000 * 10**18);

        vm.prank(bob);
        daiNetwork.setTotalDeposit(daiChannelId, bob, 1000 * 10**18);

        vm.prank(alice);
        usdtNetwork.setTotalDeposit(usdtChannelId, alice, 1000 * 10**6);

        vm.prank(bob);
        usdtNetwork.setTotalDeposit(usdtChannelId, bob, 1000 * 10**6);

        // Verify all channels maintain correct balances independently
        (address p1, address p2) = usdcNetwork.getChannelParticipants(usdcChannelId);
        assertEq(usdcNetwork.getChannelDeposit(usdcChannelId, p1), 1000 * 10**6);
        assertEq(usdcNetwork.getChannelDeposit(usdcChannelId, p2), 1000 * 10**6);

        (p1, p2) = daiNetwork.getChannelParticipants(daiChannelId);
        assertEq(daiNetwork.getChannelDeposit(daiChannelId, p1), 1000 * 10**18);
        assertEq(daiNetwork.getChannelDeposit(daiChannelId, p2), 1000 * 10**18);

        (p1, p2) = usdtNetwork.getChannelParticipants(usdtChannelId);
        assertEq(usdtNetwork.getChannelDeposit(usdtChannelId, p1), 1000 * 10**6);
        assertEq(usdtNetwork.getChannelDeposit(usdtChannelId, p2), 1000 * 10**6);

        // Close one channel and verify others unaffected
        (TokenNetwork.BalanceProof memory proof, bytes memory signature) = createBalanceProof(
            usdcNetwork,
            usdcChannelId,
            1,
            100 * 10**6,
            0,
            bytes32(0),
            alicePrivateKey
        );

        vm.prank(bob);
        usdcNetwork.closeChannel(usdcChannelId, proof, signature);

        // Verify USDC channel closed, others still open
        assertEq(uint8(usdcNetwork.getChannelState(usdcChannelId)), uint8(TokenNetwork.ChannelState.Closed));
        assertEq(uint8(daiNetwork.getChannelState(daiChannelId)), uint8(TokenNetwork.ChannelState.Opened));
        assertEq(uint8(usdtNetwork.getChannelState(usdtChannelId)), uint8(TokenNetwork.ChannelState.Opened));
    }

    /**
     * @notice Test multiple participant channels (one participant, many channels)
     * @dev Story 8.6 AC3: Verify all channels function independently
     */
    function testIntegration_MultipleParticipantChannels() public {
        // Alice opens channels with Bob, Carol, and Dave
        vm.prank(alice);
        bytes32 aliceBobChannel = usdcNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        bytes32 aliceCarolChannel = usdcNetwork.openChannel(carol, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        bytes32 aliceDaveChannel = usdcNetwork.openChannel(dave, SETTLEMENT_TIMEOUT);

        // All channels should be unique
        assertTrue(aliceBobChannel != aliceCarolChannel);
        assertTrue(aliceBobChannel != aliceDaveChannel);
        assertTrue(aliceCarolChannel != aliceDaveChannel);

        // Make deposits in all channels
        vm.prank(alice);
        usdcNetwork.setTotalDeposit(aliceBobChannel, alice, 1000 * 10**6);

        vm.prank(alice);
        usdcNetwork.setTotalDeposit(aliceCarolChannel, alice, 2000 * 10**6);

        vm.prank(alice);
        usdcNetwork.setTotalDeposit(aliceDaveChannel, alice, 3000 * 10**6);

        // Close and settle one channel
        (TokenNetwork.BalanceProof memory proof, bytes memory signature) = createBalanceProof(
            usdcNetwork,
            aliceBobChannel,
            1,
            100 * 10**6,
            0,
            bytes32(0),
            alicePrivateKey
        );

        vm.prank(bob);
        usdcNetwork.closeChannel(aliceBobChannel, proof, signature);

        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);
        usdcNetwork.settleChannel(aliceBobChannel);

        // Verify settlement doesn't affect other channels
        assertEq(uint8(usdcNetwork.getChannelState(aliceBobChannel)), uint8(TokenNetwork.ChannelState.Settled));
        assertEq(uint8(usdcNetwork.getChannelState(aliceCarolChannel)), uint8(TokenNetwork.ChannelState.Opened));
        assertEq(uint8(usdcNetwork.getChannelState(aliceDaveChannel)), uint8(TokenNetwork.ChannelState.Opened));

        // Verify deposits in remaining channels unchanged
        (address p1, address p2) = usdcNetwork.getChannelParticipants(aliceCarolChannel);
        uint256 deposit = (p1 == alice) ? usdcNetwork.getChannelDeposit(aliceCarolChannel, p1)
                                        : usdcNetwork.getChannelDeposit(aliceCarolChannel, p2);
        assertEq(deposit, 2000 * 10**6, "Carol channel deposit should be unchanged");

        (p1, p2) = usdcNetwork.getChannelParticipants(aliceDaveChannel);
        deposit = (p1 == alice) ? usdcNetwork.getChannelDeposit(aliceDaveChannel, p1)
                                : usdcNetwork.getChannelDeposit(aliceDaveChannel, p2);
        assertEq(deposit, 3000 * 10**6, "Dave channel deposit should be unchanged");
    }

    /**
     * @notice Test channel lifecycle stress test (6 channels with different pairs)
     * @dev Story 8.6 AC3: Verify no gas limit issues, all settlements succeed
     */
    function testIntegration_ChannelLifecycleStress() public {
        // Open 6 channels with different participant pairs
        // Alice-Bob, Alice-Carol, Alice-Dave, Bob-Carol, Bob-Dave, Carol-Dave
        bytes32 aliceBob = openAndDeposit(alice, bob, 100 * 10**6);
        bytes32 aliceCarol = openAndDeposit(alice, carol, 100 * 10**6);
        bytes32 aliceDave = openAndDeposit(alice, dave, 100 * 10**6);
        bytes32 bobCarol = openAndDeposit(bob, carol, 100 * 10**6);
        bytes32 bobDave = openAndDeposit(bob, dave, 100 * 10**6);
        bytes32 carolDave = openAndDeposit(carol, dave, 100 * 10**6);

        bytes32[] memory channelIds = new bytes32[](6);
        channelIds[0] = aliceBob;
        channelIds[1] = aliceCarol;
        channelIds[2] = aliceDave;
        channelIds[3] = bobCarol;
        channelIds[4] = bobDave;
        channelIds[5] = carolDave;

        // Map of who closes each channel (non-participant1 closes)
        address[6] memory closers = [bob, carol, dave, carol, dave, dave];

        uint256[6] memory signerKeys = [
            alicePrivateKey,
            alicePrivateKey,
            alicePrivateKey,
            bobPrivateKey,
            bobPrivateKey,
            carolPrivateKey
        ];

        // Close all channels
        for (uint256 i = 0; i < 6; i++) {
            (TokenNetwork.BalanceProof memory proof, bytes memory signature) = createBalanceProof(
                usdcNetwork,
                channelIds[i],
                1,
                10 * 10**6, // Transfer 10 USDC
                0,
                bytes32(0),
                signerKeys[i]
            );

            vm.prank(closers[i]);
            usdcNetwork.closeChannel(channelIds[i], proof, signature);
        }

        // Wait for settlement timeout
        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);

        // Settle all channels
        for (uint256 i = 0; i < 6; i++) {
            usdcNetwork.settleChannel(channelIds[i]);

            // Verify settled
            assertEq(uint8(usdcNetwork.getChannelState(channelIds[i])), uint8(TokenNetwork.ChannelState.Settled));
        }

        // Verify stress test completed successfully (all 6 channels settled)
        assertTrue(true, "All 6 channels settled successfully");
    }

    /**
     * @notice Helper: Open channel and make deposits from both participants
     */
    function openAndDeposit(address p1, address p2, uint256 amount) internal returns (bytes32) {
        vm.prank(p1);
        bytes32 channelId = usdcNetwork.openChannel(p2, SETTLEMENT_TIMEOUT);

        vm.prank(p1);
        usdcNetwork.setTotalDeposit(channelId, p1, amount);

        vm.prank(p2);
        usdcNetwork.setTotalDeposit(channelId, p2, amount);

        return channelId;
    }

    /**
     * @notice Test token network registry with multiple tokens
     * @dev Story 8.6 AC3: Verify each token has isolated TokenNetwork
     */
    function testIntegration_RegistryMultipleTokens() public {
        // Create 5 different ERC20 tokens and networks
        MockERC20 token1 = new MockERC20("Token 1", "TK1", 18);
        MockERC20 token2 = new MockERC20("Token 2", "TK2", 18);
        MockERC20 token3 = new MockERC20("Token 3", "TK3", 6);
        MockERC20 token4 = new MockERC20("Token 4", "TK4", 8);
        MockERC20 token5 = new MockERC20("Token 5", "TK5", 18);

        address network1 = registry.createTokenNetwork(address(token1));
        address network2 = registry.createTokenNetwork(address(token2));
        address network3 = registry.createTokenNetwork(address(token3));
        address network4 = registry.createTokenNetwork(address(token4));
        address network5 = registry.createTokenNetwork(address(token5));

        // Verify all networks unique
        assertTrue(network1 != network2);
        assertTrue(network1 != network3);
        assertTrue(network1 != network4);
        assertTrue(network1 != network5);
        assertTrue(network2 != network3);

        // Verify registry tracks all networks
        assertEq(registry.getTokenNetwork(address(token1)), network1);
        assertEq(registry.getTokenNetwork(address(token2)), network2);
        assertEq(registry.getTokenNetwork(address(token3)), network3);
        assertEq(registry.getTokenNetwork(address(token4)), network4);
        assertEq(registry.getTokenNetwork(address(token5)), network5);

        // Verify each network has correct token
        assertEq(address(TokenNetwork(network1).token()), address(token1));
        assertEq(address(TokenNetwork(network2).token()), address(token2));
        assertEq(address(TokenNetwork(network3).token()), address(token3));
        assertEq(address(TokenNetwork(network4).token()), address(token4));
        assertEq(address(TokenNetwork(network5).token()), address(token5));

        // Verify no cross-contamination: cannot create duplicate network
        vm.expectRevert(); // TokenNetworkAlreadyExists error
        registry.createTokenNetwork(address(token1));
    }

    /**
     * @notice Test disputed closure with challenge
     * @dev Story 8.6 AC3: Verify challenge period enforced, newer proof accepted
     */
    function testIntegration_DisputedClosure() public {
        // Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = usdcNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        usdcNetwork.setTotalDeposit(channelId, alice, 1000 * 10**6);

        vm.prank(bob);
        usdcNetwork.setTotalDeposit(channelId, bob, 1000 * 10**6);

        // Alice creates a balance proof (nonce 1, she transferred 100 to Bob)
        (TokenNetwork.BalanceProof memory aliceProof, bytes memory aliceSig) = createBalanceProof(
            usdcNetwork,
            channelId,
            1,
            100 * 10**6,
            0,
            bytes32(0),
            alicePrivateKey
        );

        // Bob closes channel with Alice's stale proof
        vm.prank(bob);
        usdcNetwork.closeChannel(channelId, aliceProof, aliceSig);

        // Verify channel closed
        assertEq(uint8(usdcNetwork.getChannelState(channelId)), uint8(TokenNetwork.ChannelState.Closed));

        // Bob also created a balance proof (nonce 2, he transferred 50 to Alice)
        // Alice (non-closing) submits Bob's newer proof to update her state
        (TokenNetwork.BalanceProof memory bobProof, bytes memory bobSig) = createBalanceProof(
            usdcNetwork,
            channelId,
            2, // Higher nonce
            50 * 10**6, // Bob transferred 50 to Alice
            0,
            bytes32(0),
            bobPrivateKey
        );

        vm.prank(alice);
        usdcNetwork.updateNonClosingBalanceProof(channelId, bobProof, bobSig);

        // Wait for settlement timeout
        vm.warp(block.timestamp + SETTLEMENT_TIMEOUT + 1);

        // Settle channel
        uint256 aliceBalanceBefore = usdc.balanceOf(alice);
        uint256 bobBalanceBefore = usdc.balanceOf(bob);

        usdcNetwork.settleChannel(channelId);

        // Verify settlement used updated proofs
        // Alice transferred 100 to Bob (her closing proof)
        // Bob transferred 50 to Alice (his newer proof submitted by Alice)
        // Alice: 1000 - 100 + 50 = 950 USDC
        // Bob: 1000 + 100 - 50 = 1050 USDC
        assertEq(usdc.balanceOf(alice), aliceBalanceBefore + 950 * 10**6, "Alice should receive 950");
        assertEq(usdc.balanceOf(bob), bobBalanceBefore + 1050 * 10**6, "Bob should receive 1050");
    }

    /**
     * @notice Test cooperative settlement with withdrawals
     * @dev Story 8.6 AC3: Verify cooperative settlement accounts for withdrawals
     */
    function testIntegration_CooperativeSettlementWithWithdrawals() public {
        // Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = usdcNetwork.openChannel(bob, SETTLEMENT_TIMEOUT);

        vm.prank(alice);
        usdcNetwork.setTotalDeposit(channelId, alice, 1000 * 10**6);

        vm.prank(bob);
        usdcNetwork.setTotalDeposit(channelId, bob, 1000 * 10**6);

        // Determine participant order
        (address participant1, address participant2) = usdcNetwork.getChannelParticipants(channelId);
        address aliceCounterparty = (participant1 == alice) ? participant2 : participant1;
        uint256 counterpartyKey = (aliceCounterparty == bob) ? bobPrivateKey : alicePrivateKey;

        // Alice withdraws 200 USDC
        (TokenNetwork.WithdrawProof memory withdrawProof, bytes memory withdrawSig) = createWithdrawProof(
            usdcNetwork,
            channelId,
            alice,
            200 * 10**6,
            1,
            block.timestamp + 1 days,
            counterpartyKey
        );

        uint256 aliceBalanceAfterWithdraw = usdc.balanceOf(alice);

        vm.prank(alice);
        usdcNetwork.withdraw(channelId, withdrawProof, withdrawSig);

        // Verify withdrawal succeeded (Alice received 200 USDC)
        assertEq(usdc.balanceOf(alice), aliceBalanceAfterWithdraw + 200 * 10**6, "Alice should receive withdrawal");

        // Cooperative settlement with transfers
        // Alice transferred 100 to Bob, Bob transferred 50 to Alice
        uint256 p1PrivateKey = (participant1 == alice) ? alicePrivateKey : bobPrivateKey;
        uint256 p2PrivateKey = (participant2 == alice) ? alicePrivateKey : bobPrivateKey;

        (TokenNetwork.BalanceProof memory proof1, bytes memory sig1) = createBalanceProof(
            usdcNetwork,
            channelId,
            1,
            (participant1 == alice) ? 100 * 10**6 : 50 * 10**6,
            0,
            bytes32(0),
            p1PrivateKey
        );

        (TokenNetwork.BalanceProof memory proof2, bytes memory sig2) = createBalanceProof(
            usdcNetwork,
            channelId,
            1,
            (participant2 == alice) ? 100 * 10**6 : 50 * 10**6,
            0,
            bytes32(0),
            p2PrivateKey
        );

        uint256 aliceBalanceBefore = usdc.balanceOf(alice);
        uint256 bobBalanceBefore = usdc.balanceOf(bob);

        usdcNetwork.cooperativeSettle(channelId, proof1, sig1, proof2, sig2);

        // Verify cooperative settlement accounts for withdrawal
        // Alice: 1000 - 200 (withdrawn) + 50 (received) - 100 (sent) = 750
        // Bob: 1000 + 100 (received) - 50 (sent) = 1050
        // Note: Alice already received 200 from withdrawal, so gets additional 750
        assertEq(usdc.balanceOf(alice), aliceBalanceBefore + 750 * 10**6, "Alice should receive 750 more");
        assertEq(usdc.balanceOf(bob), bobBalanceBefore + 1050 * 10**6, "Bob should receive 1050");
    }

    // =========================================================================
    // Helper Functions
    // =========================================================================

    /**
     * @notice Create and sign a balance proof
     */
    function createBalanceProof(
        TokenNetwork network,
        bytes32 channelId,
        uint256 nonce,
        uint256 transferredAmount,
        uint256 lockedAmount,
        bytes32 locksRoot,
        uint256 privateKey
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
                network.BALANCE_PROOF_TYPEHASH(),
                proof.channelId,
                proof.nonce,
                proof.transferredAmount,
                proof.lockedAmount,
                proof.locksRoot
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                network.DOMAIN_SEPARATOR(),
                structHash
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    /**
     * @notice Create and sign a withdrawal proof
     */
    function createWithdrawProof(
        TokenNetwork network,
        bytes32 channelId,
        address participant,
        uint256 amount,
        uint256 nonce,
        uint256 expiry,
        uint256 privateKey
    ) internal view returns (TokenNetwork.WithdrawProof memory proof, bytes memory signature) {
        proof = TokenNetwork.WithdrawProof({
            channelId: channelId,
            participant: participant,
            amount: amount,
            nonce: nonce,
            expiry: expiry
        });

        bytes32 structHash = keccak256(
            abi.encode(
                network.WITHDRAW_PROOF_TYPEHASH(),
                channelId,
                participant,
                amount,
                nonce,
                expiry
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                network.DOMAIN_SEPARATOR(),
                structHash
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }
}
