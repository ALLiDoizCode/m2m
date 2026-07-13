// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/RollingSwapChannel.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockERC20WithFee.sol";
import "./mocks/MockReentrantToken.sol";

/// @title RollingSwapChannelTest
/// @notice Unit tests for the production chain-B rolling-swap settlement contract.
contract RollingSwapChannelTest is Test {
    RollingSwapChannel internal channel;
    MockERC20 internal token;

    // The swap node's chain-B claim signer.
    uint256 internal signerPk = 0x5157;
    address internal signerAddr;

    // The funder (maker treasury) and recipient (sender).
    address internal funder = address(0xF00D);
    uint256 internal recipientPk = 0x4EC1;
    address internal recipient;

    bytes32 internal constant CHANNEL_ID = bytes32(uint256(0x5b));
    uint256 internal constant CHALLENGE = 1 days;
    uint256 internal constant DEPOSIT = 100_000e6; // 100k USDC (6dp)

    // Re-declared for expectEmit.
    event ChannelOpened(bytes32 indexed channelId, address indexed signer, address indexed funder, uint256 deposit);
    event SettlementSucceeded(
        bytes32 indexed channelId, uint256 cumulativeAmount, uint256 nonce, address indexed recipient
    );
    event ChannelClosed(bytes32 indexed channelId, address indexed funder, uint256 remainderReturned, bool cooperative);

    function setUp() public {
        signerAddr = vm.addr(signerPk);
        recipient = vm.addr(recipientPk);

        token = new MockERC20("USD Coin", "USDC", 6);
        channel = new RollingSwapChannel(address(token), CHALLENGE);

        // Fund the funder and approve.
        token.transfer(funder, DEPOSIT * 2);
        vm.prank(funder);
        token.approve(address(channel), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Signing helpers — reproduce the swap node's raw balance-proof signature
    // (r||s||v, v=27+recovery, NO EIP-191/712 prefix).
    // ---------------------------------------------------------------------

    function _signClaim(uint256 pk, bytes32 channelId, uint256 cumulative, uint256 nonce, address to)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encodePacked(channelId, cumulative, nonce, to));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signCoopClose(uint256 pk, bytes32 channelId, uint256 cumulative, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = channel.cooperativeCloseDigest(channelId, cumulative, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _open() internal {
        vm.prank(funder);
        channel.openChannel(CHANNEL_ID, signerAddr, DEPOSIT);
    }

    // ---------------------------------------------------------------------
    // ABI-compatibility locks — guard against silent drift from the sdk/client
    // ---------------------------------------------------------------------

    function testAbiSelectorMatchesSdk() public pure {
        // @toon-protocol/sdk buildEvmSettlementTx builds this exact selector.
        bytes4 expected = bytes4(keccak256("updateBalance(bytes32,uint256,uint256,address,bytes)"));
        assertEq(RollingSwapChannel.updateBalance.selector, expected, "updateBalance selector drift");
    }

    function testAbiEventTopicMatchesSdk() public pure {
        // The sdk sets bundle.expectedEventSignature to this topic; the client
        // reads channelId(topic1), cumulative(data[0]), nonce(data[1]).
        bytes32 expected = keccak256("SettlementSucceeded(bytes32,uint256,uint256,address)");
        assertEq(SettlementSucceeded.selector, expected, "SettlementSucceeded topic drift");
    }

    function testClaimDigestMatchesBalanceProofHashEvm() public view {
        // Lock the digest preimage: channelId(32) || cumulative(32BE) ||
        // nonce(32BE) || recipient(20) — byte-for-byte balanceProofHashEvm.
        uint256 cumulative = 24_000_000;
        uint256 nonce = 24;
        bytes32 manual = keccak256(abi.encodePacked(CHANNEL_ID, cumulative, nonce, recipient));
        assertEq(channel.claimDigest(CHANNEL_ID, cumulative, nonce, recipient), manual, "claim digest drift");
    }

    /// @notice GOLDEN PIN (finding #5): the claim digest preimage is pinned to a
    ///         hard-coded expected bytes32 for a fixed known input. Because both
    ///         updateBalance and cooperativeClose now build the digest through
    ///         the single internal _claimDigest (surfaced by claimDigest()), any
    ///         future accidental change to the preimage bytes breaks this test —
    ///         which is the whole point: the wire format is ABI-locked.
    ///         Input: channelId=0x5b, cumulative=24_000_000, nonce=24,
    ///         recipient=0x00000000000000000000000000000000DEADBEEF.
    function testClaimDigestGoldenPin() public view {
        bytes32 expected = 0xc5c584f6967bc3b48c9e738cbb64e7f039fc6f560b6f9a3a06c101ffcfc22287;
        assertEq(
            channel.claimDigest(bytes32(uint256(0x5b)), 24_000_000, 24, address(0xDEADBEEF)),
            expected,
            "claim digest preimage changed - the ABI-locked wire format drifted"
        );
    }

    // ---------------------------------------------------------------------
    // Constructor / open guards
    // ---------------------------------------------------------------------

    function testConstructorRejectsZeroToken() public {
        vm.expectRevert(RollingSwapChannel.InvalidToken.selector);
        new RollingSwapChannel(address(0), CHALLENGE);
    }

    function testConstructorRejectsShortChallenge() public {
        // Floor is now 1 day (finding #7): anything below it must revert.
        vm.expectRevert(RollingSwapChannel.InvalidChallengePeriod.selector);
        new RollingSwapChannel(address(token), 1 hours);
        vm.expectRevert(RollingSwapChannel.InvalidChallengePeriod.selector);
        new RollingSwapChannel(address(token), 1 days - 1);
    }

    function testConstructorAcceptsChallengeAtFloor() public {
        // Exactly the 1-day floor is accepted (deploy scripts default to 1 day).
        RollingSwapChannel c = new RollingSwapChannel(address(token), 1 days);
        assertEq(c.challengePeriod(), 1 days);
        assertEq(c.MIN_CHALLENGE_PERIOD(), 1 days);
    }

    function testOpenChannelHappyPath() public {
        vm.expectEmit(true, true, true, true);
        emit ChannelOpened(CHANNEL_ID, signerAddr, funder, DEPOSIT);
        _open();

        (address s, address f, uint256 nonce, uint256 paid, uint256 dep,, RollingSwapChannel.ChannelState state) =
            channel.channels(CHANNEL_ID);
        assertEq(s, signerAddr);
        assertEq(f, funder);
        assertEq(nonce, 0);
        assertEq(paid, 0);
        assertEq(dep, DEPOSIT);
        assertEq(uint256(state), uint256(RollingSwapChannel.ChannelState.Open));
        assertEq(token.balanceOf(address(channel)), DEPOSIT);
    }

    function testOpenChannelRejectsDuplicate() public {
        _open();
        vm.prank(funder);
        vm.expectRevert(RollingSwapChannel.ChannelExists.selector);
        channel.openChannel(CHANNEL_ID, signerAddr, DEPOSIT);
    }

    function testOpenChannelRejectsZeroSigner() public {
        vm.prank(funder);
        vm.expectRevert(RollingSwapChannel.InvalidSigner.selector);
        channel.openChannel(CHANNEL_ID, address(0), DEPOSIT);
    }

    function testOpenChannelRejectsZeroDeposit() public {
        vm.prank(funder);
        vm.expectRevert(RollingSwapChannel.ZeroDeposit.selector);
        channel.openChannel(CHANNEL_ID, signerAddr, 0);
    }

    function testDepositTopUp() public {
        _open();
        vm.prank(funder);
        channel.deposit(CHANNEL_ID, 50_000e6);
        (,,,, uint256 dep,,) = channel.channels(CHANNEL_ID);
        assertEq(dep, DEPOSIT + 50_000e6);
    }

    function testFeeOnTransferCreditsActualReceived() public {
        MockERC20WithFee feeToken = new MockERC20WithFee("Fee", "FEE", 6, 10); // 10%
        RollingSwapChannel feeChannel = new RollingSwapChannel(address(feeToken), CHALLENGE);
        feeToken.transfer(funder, DEPOSIT * 2); // net-of-fee still covers the open
        vm.startPrank(funder);
        feeToken.approve(address(feeChannel), type(uint256).max);
        feeChannel.openChannel(CHANNEL_ID, signerAddr, 100_000e6);
        vm.stopPrank();
        (,,,, uint256 dep,,) = feeChannel.channels(CHANNEL_ID);
        assertEq(dep, 90_000e6, "should credit net-of-fee received amount");
    }

    // ---------------------------------------------------------------------
    // updateBalance — the redeem path
    // ---------------------------------------------------------------------

    function testRedeemValidClaimPaysCumulative() public {
        _open();
        uint256 cumulative = 24_000_000;
        uint256 nonce = 24;
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, cumulative, nonce, recipient);

        vm.expectEmit(true, true, true, true);
        emit SettlementSucceeded(CHANNEL_ID, cumulative, nonce, recipient);
        channel.updateBalance(CHANNEL_ID, cumulative, nonce, recipient, sig);

        assertEq(token.balanceOf(recipient), cumulative, "recipient paid the cumulative amount");
        (,, uint256 storedNonce, uint256 paid, uint256 dep,,) = channel.channels(CHANNEL_ID);
        assertEq(storedNonce, nonce);
        assertEq(paid, cumulative);
        assertEq(dep, DEPOSIT - cumulative);
    }

    function testAnyoneCanSubmitClaim() public {
        // The claim carries its own authorization (the signer's signature) and
        // pays the signature-bound recipient — a keeper/relayer can submit it.
        _open();
        uint256 cumulative = 5_000_000;
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, cumulative, 1, recipient);
        vm.prank(address(0xBEEF)); // arbitrary submitter
        channel.updateBalance(CHANNEL_ID, cumulative, 1, recipient, sig);
        assertEq(token.balanceOf(recipient), cumulative);
    }

    function testNettingHighestNonceWins() public {
        // N cumulative claims net to one payout: only the delta over the last
        // settled cumulative ever moves.
        _open();
        bytes memory sig1 = _signClaim(signerPk, CHANNEL_ID, 1_000_000, 1, recipient);
        channel.updateBalance(CHANNEL_ID, 1_000_000, 1, recipient, sig1);
        assertEq(token.balanceOf(recipient), 1_000_000);

        bytes memory sig5 = _signClaim(signerPk, CHANNEL_ID, 5_000_000, 5, recipient);
        channel.updateBalance(CHANNEL_ID, 5_000_000, 5, recipient, sig5);
        // Recipient now holds the cumulative total, not the sum of deltas twice.
        assertEq(token.balanceOf(recipient), 5_000_000);
        (,,, uint256 paid,,,) = channel.channels(CHANNEL_ID);
        assertEq(paid, 5_000_000);
    }

    function testStaleNonceRejected() public {
        _open();
        bytes memory sig5 = _signClaim(signerPk, CHANNEL_ID, 5_000_000, 5, recipient);
        channel.updateBalance(CHANNEL_ID, 5_000_000, 5, recipient, sig5);

        // A claim with nonce <= stored is rejected even if otherwise valid.
        bytes memory sigStale = _signClaim(signerPk, CHANNEL_ID, 6_000_000, 5, recipient);
        vm.expectRevert(RollingSwapChannel.StaleNonce.selector);
        channel.updateBalance(CHANNEL_ID, 6_000_000, 5, recipient, sigStale);

        bytes memory sigOlder = _signClaim(signerPk, CHANNEL_ID, 6_000_000, 4, recipient);
        vm.expectRevert(RollingSwapChannel.StaleNonce.selector);
        channel.updateBalance(CHANNEL_ID, 6_000_000, 4, recipient, sigOlder);
    }

    function testStaleCumulativeRejected() public {
        _open();
        bytes memory sig5 = _signClaim(signerPk, CHANNEL_ID, 5_000_000, 5, recipient);
        channel.updateBalance(CHANNEL_ID, 5_000_000, 5, recipient, sig5);

        // Higher nonce but non-increasing cumulative is rejected.
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, 5_000_000, 6, recipient);
        vm.expectRevert(RollingSwapChannel.StaleCumulativeAmount.selector);
        channel.updateBalance(CHANNEL_ID, 5_000_000, 6, recipient, sig);
    }

    function testWrongSignerRejected() public {
        _open();
        uint256 wrongPk = 0xBAD;
        bytes memory sig = _signClaim(wrongPk, CHANNEL_ID, 1_000_000, 1, recipient);
        vm.expectRevert(RollingSwapChannel.BadSignature.selector);
        channel.updateBalance(CHANNEL_ID, 1_000_000, 1, recipient, sig);
    }

    function testTamperedRecipientRejected() public {
        // Signature is over (channelId, cumulative, nonce, recipient). Redeeming
        // to a different recipient than signed recovers a different address.
        _open();
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, 1_000_000, 1, recipient);
        vm.expectRevert(RollingSwapChannel.BadSignature.selector);
        channel.updateBalance(CHANNEL_ID, 1_000_000, 1, address(0xDEAD), sig);
    }

    function testBadSignatureLengthRejected() public {
        _open();
        vm.expectRevert(RollingSwapChannel.BadSignatureLength.selector);
        channel.updateBalance(CHANNEL_ID, 1_000_000, 1, recipient, new bytes(64));
    }

    function testClaimExceedingDepositRejected() public {
        _open();
        uint256 tooMuch = DEPOSIT + 1;
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, tooMuch, 1, recipient);
        vm.expectRevert(RollingSwapChannel.InsufficientDeposit.selector);
        channel.updateBalance(CHANNEL_ID, tooMuch, 1, recipient, sig);
    }

    function testRedeemUnknownChannelRejected() public {
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, 1_000_000, 1, recipient);
        vm.expectRevert(RollingSwapChannel.InvalidChannelState.selector);
        channel.updateBalance(CHANNEL_ID, 1_000_000, 1, recipient, sig);
    }

    // ---------------------------------------------------------------------
    // Cooperative close (Mina co-sign analog)
    // ---------------------------------------------------------------------

    function testCooperativeClosePaysRecipientAndRefundsFunder() public {
        _open();
        uint256 cumulative = 10_000_000;
        uint256 nonce = 10;
        bytes memory signerSig = _signClaim(signerPk, CHANNEL_ID, cumulative, nonce, recipient);
        bytes memory recipSig = _signCoopClose(recipientPk, CHANNEL_ID, cumulative, nonce);

        uint256 funderBefore = token.balanceOf(funder);
        vm.expectEmit(true, true, false, true);
        emit ChannelClosed(CHANNEL_ID, funder, DEPOSIT - cumulative, true);
        channel.cooperativeClose(CHANNEL_ID, cumulative, nonce, recipient, signerSig, recipSig);

        assertEq(token.balanceOf(recipient), cumulative, "recipient paid final watermark");
        assertEq(token.balanceOf(funder), funderBefore + (DEPOSIT - cumulative), "funder refunded remainder");
        (,,,, uint256 dep,, RollingSwapChannel.ChannelState state) = channel.channels(CHANNEL_ID);
        assertEq(dep, 0);
        assertEq(uint256(state), uint256(RollingSwapChannel.ChannelState.Closed));
    }

    function testCooperativeClosePureTeardown() public {
        // Redeem via updateBalance first, then cooperatively tear down at the
        // same watermark: no new delta, just the funder's remainder.
        _open();
        uint256 cumulative = 4_000_000;
        uint256 nonce = 4;
        channel.updateBalance(
            CHANNEL_ID, cumulative, nonce, recipient, _signClaim(signerPk, CHANNEL_ID, cumulative, nonce, recipient)
        );
        uint256 funderBefore = token.balanceOf(funder);

        bytes memory signerSig = _signClaim(signerPk, CHANNEL_ID, cumulative, nonce, recipient);
        bytes memory recipSig = _signCoopClose(recipientPk, CHANNEL_ID, cumulative, nonce);
        channel.cooperativeClose(CHANNEL_ID, cumulative, nonce, recipient, signerSig, recipSig);

        assertEq(token.balanceOf(recipient), cumulative, "no double pay");
        assertEq(token.balanceOf(funder), funderBefore + (DEPOSIT - cumulative));
    }

    function testCooperativeCloseRejectsWrongRecipientSig() public {
        _open();
        uint256 cumulative = 10_000_000;
        uint256 nonce = 10;
        bytes memory signerSig = _signClaim(signerPk, CHANNEL_ID, cumulative, nonce, recipient);
        bytes memory badRecipSig = _signCoopClose(0xBAD, CHANNEL_ID, cumulative, nonce); // not the recipient
        vm.expectRevert(RollingSwapChannel.BadSignature.selector);
        channel.cooperativeClose(CHANNEL_ID, cumulative, nonce, recipient, signerSig, badRecipSig);
    }

    function testCooperativeCloseRejectsWrongSignerSig() public {
        _open();
        uint256 cumulative = 10_000_000;
        uint256 nonce = 10;
        bytes memory badSignerSig = _signClaim(0xBAD, CHANNEL_ID, cumulative, nonce, recipient);
        bytes memory recipSig = _signCoopClose(recipientPk, CHANNEL_ID, cumulative, nonce);
        vm.expectRevert(RollingSwapChannel.BadSignature.selector);
        channel.cooperativeClose(CHANNEL_ID, cumulative, nonce, recipient, badSignerSig, recipSig);
    }

    // ---------------------------------------------------------------------
    // Unilateral / challenge-timeout close
    // ---------------------------------------------------------------------

    function testInitiateCloseOnlyFunder() public {
        _open();
        vm.prank(address(0xBEEF));
        vm.expectRevert(RollingSwapChannel.NotFunder.selector);
        channel.initiateClose(CHANNEL_ID);
    }

    function testRedeemStillWorksDuringChallenge() public {
        _open();
        vm.prank(funder);
        channel.initiateClose(CHANNEL_ID);

        // Recipient can still redeem the final watermark mid-challenge.
        uint256 cumulative = 3_000_000;
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, cumulative, 3, recipient);
        channel.updateBalance(CHANNEL_ID, cumulative, 3, recipient, sig);
        assertEq(token.balanceOf(recipient), cumulative);
    }

    function testWithdrawRemainderBeforeExpiryRejected() public {
        _open();
        vm.prank(funder);
        channel.initiateClose(CHANNEL_ID);
        vm.expectRevert(RollingSwapChannel.ChallengeNotExpired.selector);
        channel.withdrawRemainder(CHANNEL_ID);
    }

    function testWithdrawRemainderAfterExpiryRefundsFunder() public {
        _open();
        // Recipient redeems part first.
        uint256 cumulative = 3_000_000;
        channel.updateBalance(
            CHANNEL_ID, cumulative, 3, recipient, _signClaim(signerPk, CHANNEL_ID, cumulative, 3, recipient)
        );

        vm.prank(funder);
        channel.initiateClose(CHANNEL_ID);
        assertEq(channel.challengeEndsAt(CHANNEL_ID), block.timestamp + CHALLENGE);

        vm.warp(block.timestamp + CHALLENGE + 1);
        uint256 funderBefore = token.balanceOf(funder);
        channel.withdrawRemainder(CHANNEL_ID);

        assertEq(token.balanceOf(funder), funderBefore + (DEPOSIT - cumulative), "funder gets unspent deposit");
        (,,,, uint256 dep,, RollingSwapChannel.ChannelState state) = channel.channels(CHANNEL_ID);
        assertEq(dep, 0);
        assertEq(uint256(state), uint256(RollingSwapChannel.ChannelState.Closed));
    }

    function testRedeemAfterClosedRejected() public {
        _open();
        vm.prank(funder);
        channel.initiateClose(CHANNEL_ID);
        vm.warp(block.timestamp + CHALLENGE + 1);
        channel.withdrawRemainder(CHANNEL_ID);

        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, 1_000_000, 1, recipient);
        vm.expectRevert(RollingSwapChannel.InvalidChannelState.selector);
        channel.updateBalance(CHANNEL_ID, 1_000_000, 1, recipient, sig);
    }

    function testDoubleInitiateCloseRejected() public {
        _open();
        vm.startPrank(funder);
        channel.initiateClose(CHANNEL_ID);
        vm.expectRevert(RollingSwapChannel.InvalidChannelState.selector);
        channel.initiateClose(CHANNEL_ID);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Re-entrancy guard
    // ---------------------------------------------------------------------

    function testReentrancyGuardBlocksRecursiveRedeem() public {
        MockReentrantToken reToken = new MockReentrantToken();
        RollingSwapChannel reChannel = new RollingSwapChannel(address(reToken), CHALLENGE);
        reToken.setTarget(address(reChannel));

        reToken.transfer(funder, DEPOSIT);
        vm.startPrank(funder);
        reToken.approve(address(reChannel), type(uint256).max);
        reChannel.openChannel(CHANNEL_ID, signerAddr, DEPOSIT);
        vm.stopPrank();

        reToken.arm(true); // transfer() will attempt to re-enter updateBalance
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, 1_000_000, 1, recipient);
        // The recursive call hits nonReentrant and reverts; the revert bubbles
        // through the token transfer and fails the whole redeem.
        vm.expectRevert();
        reChannel.updateBalance(CHANNEL_ID, 1_000_000, 1, recipient, sig);

        // No state moved: recipient unpaid, deposit intact.
        assertEq(reToken.balanceOf(recipient), 0);
        (,,, uint256 paid, uint256 dep,,) = reChannel.channels(CHANNEL_ID);
        assertEq(paid, 0);
        assertEq(dep, DEPOSIT);
    }

    // ---------------------------------------------------------------------
    // Overflow / accounting invariants (Solidity 0.8 checked math)
    // ---------------------------------------------------------------------

    function testFuzzDeltaNeverUnderflowsDeposit(uint256 c1, uint256 c2) public {
        _open();
        c1 = bound(c1, 1, DEPOSIT - 1);
        c2 = bound(c2, c1 + 1, DEPOSIT); // strictly increasing, within deposit
        channel.updateBalance(CHANNEL_ID, c1, 1, recipient, _signClaim(signerPk, CHANNEL_ID, c1, 1, recipient));
        channel.updateBalance(CHANNEL_ID, c2, 2, recipient, _signClaim(signerPk, CHANNEL_ID, c2, 2, recipient));
        assertEq(token.balanceOf(recipient), c2, "cumulative paid == highest watermark");
        (,,,, uint256 dep,,) = channel.channels(CHANNEL_ID);
        assertEq(dep, DEPOSIT - c2);
    }
}
