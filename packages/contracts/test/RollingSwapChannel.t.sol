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
    // Signing helpers — reproduce the swap node's v2 balance-proof signature:
    // an EIP-712 typed-data signature (domain RollingSwapChannel/2, bound to
    // chainId + address(this)) returned as a raw r||s||v 65-byte blob.
    // ---------------------------------------------------------------------

    function _signClaim(uint256 pk, bytes32 channelId, uint256 cumulative, uint256 nonce, address to)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = channel.claimDigest(channelId, cumulative, nonce, to);
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

    /// @notice V2 typehashes are pinned (finding #1). Any edit to the struct
    ///         string breaks this — the other three repos hardcode these.
    function testV2TypehashesPinned() public pure {
        assertEq(
            keccak256("ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)"),
            0xa0c8262c1a8615f7674d3af796b14d19672d3634f89c6093502ab35c0afe2d91,
            "ClaimBalanceProof typehash drift"
        );
        assertEq(
            keccak256("CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)"),
            0xa5753389755fea51cd5016d7b02b508ac03f2e822d9a7ee345ec45b36574ff9f,
            "CooperativeClose typehash drift"
        );
    }

    /// @notice Lock the v2 claim digest to an INDEPENDENT manual EIP-712
    ///         recomputation: keccak256(0x1901 || domainSeparator || structHash)
    ///         where structHash = keccak256(abi.encode(CLAIM_TYPEHASH, ...)).
    ///         Proves the contract's `_hashTypedDataV4` path equals the raw
    ///         EIP-712 algorithm the sdk/swap signer/client must reproduce.
    function testClaimDigestMatchesV2Eip712() public view {
        uint256 cumulative = 24_000_000;
        uint256 nonce = 24;
        bytes32 claimTypehash =
            keccak256("ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)");
        bytes32 structHash = keccak256(abi.encode(claimTypehash, CHANNEL_ID, cumulative, nonce, recipient));
        bytes32 manual = keccak256(abi.encodePacked(hex"1901", channel.domainSeparator(), structHash));
        assertEq(channel.claimDigest(CHANNEL_ID, cumulative, nonce, recipient), manual, "v2 claim digest drift");

        bytes32 coopTypehash = keccak256("CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)");
        bytes32 coopStruct = keccak256(abi.encode(coopTypehash, CHANNEL_ID, cumulative, nonce));
        bytes32 coopManual = keccak256(abi.encodePacked(hex"1901", channel.domainSeparator(), coopStruct));
        assertEq(
            channel.cooperativeCloseDigest(CHANNEL_ID, cumulative, nonce), coopManual, "v2 coop-close digest drift"
        );
    }

    /// @notice GOLDEN VECTOR PIN (finding #1). Pins the v2 domain separator,
    ///         claim digest, and cooperative-close digest to the hard-coded hex
    ///         in `docs/rolling-swap-v2-digest-spec.md`. The other three repos
    ///         (core/sdk, swap signer, client) conform to THESE literals, so a
    ///         drift here (or in OZ's EIP712) breaks CI loudly.
    ///
    ///         Deployed at the fixed verifyingContract on the fixed chainId
    ///         (Base, 8453) so the domain separator matches the golden vector.
    ///         Inputs: channelId=0x5b, cumulative=24_000_000, nonce=24,
    ///         recipient=0x00000000000000000000000000000000DEADBEEF.
    function testV2GoldenVectorPin() public {
        vm.chainId(8453);
        address vc = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
        deployCodeTo("RollingSwapChannel.sol:RollingSwapChannel", abi.encode(address(token), CHALLENGE), vc);
        RollingSwapChannel pinned = RollingSwapChannel(vc);

        assertEq(
            pinned.domainSeparator(),
            0xb94d6e9c9c28083295de906f48c4db4110392800177aad52c3f99f2afbce594f,
            "v2 domain separator golden drift"
        );

        bytes32 cid = bytes32(uint256(0x5b));
        assertEq(
            pinned.claimDigest(cid, 24_000_000, 24, address(0xDEADBEEF)),
            0x8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede,
            "v2 claim digest golden drift"
        );
        assertEq(
            pinned.cooperativeCloseDigest(cid, 24_000_000, 24),
            0x8b748bdfc330a591164551d4b536d64b963aff1059b594acc1dc5a24297e25c0,
            "v2 coop-close digest golden drift"
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
