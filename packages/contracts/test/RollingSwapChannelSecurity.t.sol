// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "../src/RollingSwapChannel.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockERC20WithFee.sol";

/// @title RollingSwapChannelSecurityTest
/// @notice Security-negative tests hardening the chain-B settlement contract
///         against the SAFE (non-ABI-breaking) findings from the connector#320
///         review. Adversarial PoCs are adapted here into regression tests.
///
///         Findings exercised:
///           #3  deposit() funder-guard (attacker top-up reverts NotFunder)
///           #9a malleable/high-s + invalid-v signature rejection (OZ ECDSA)
///           #9c channelId squat / open griefing (ChannelExists)
///           #9d cooperativeClose InsufficientDeposit branch
///           #9e cooperativeClose from the Closing state
///           #9f fee-on-transfer on the deposit() top-up path
///           #1  cross-deployment replay — DOCUMENTED as a known limitation
///               (NOT fixed here; digest lacks chainId/address separation)
contract RollingSwapChannelSecurityTest is Test {
    // secp256k1 group order (for constructing a malleable high-s signature).
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    RollingSwapChannel internal channel;
    MockERC20 internal token;

    uint256 internal signerPk = 0x5157;
    address internal signerAddr;
    uint256 internal recipientPk = 0x4EC1;
    address internal recipient;

    address internal funder = address(0xF00D);
    address internal attacker = address(0xBADBEEF);

    bytes32 internal constant CHANNEL_ID = bytes32(uint256(0x5b));
    uint256 internal constant CHALLENGE = 1 days;
    uint256 internal constant DEPOSIT = 100_000e6;

    function setUp() public {
        signerAddr = vm.addr(signerPk);
        recipient = vm.addr(recipientPk);

        token = new MockERC20("USD Coin", "USDC", 6);
        channel = new RollingSwapChannel(address(token), CHALLENGE);

        token.transfer(funder, DEPOSIT * 2);
        token.transfer(attacker, DEPOSIT);
        vm.prank(funder);
        token.approve(address(channel), type(uint256).max);
        vm.prank(attacker);
        token.approve(address(channel), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Signing helpers (raw r||s||v, v=27+recovery, NO EIP-191/712 prefix).
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

    // =====================================================================
    // #9a — malleable (high-s) and invalid-v signatures are rejected.
    // =====================================================================

    /// A high-s counterpart of a valid signature is a second valid ECDSA
    /// signature for the same digest (signature malleability). OZ ECDSA.recover
    /// rejects it (ECDSAInvalidSignatureS) so it can never be redeemed —
    /// preventing a relayer from reshaping a claim into a distinct-looking blob.
    function testMalleableHighSSignatureRejected() public {
        _open();
        uint256 cumulative = 1_000_000;
        uint256 nonce = 1;
        bytes32 digest = keccak256(abi.encodePacked(CHANNEL_ID, cumulative, nonce, recipient));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);

        // Flip to the malleable high-s form: s' = n - s, v' = 27<->28.
        bytes32 sHigh = bytes32(SECP256K1_N - uint256(s));
        uint8 vHigh = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, sHigh, vHigh);

        // vm.sign returns the canonical low-s signature; (r, n-s, flipped v) is
        // its malleable high-s twin - a second valid ECDSA sig for the same
        // digest that OZ ECDSA.recover refuses (ECDSAInvalidSignatureS carries
        // the offending s, so match the full error data).
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, sHigh));
        channel.updateBalance(CHANNEL_ID, cumulative, nonce, recipient, malleable);
    }

    /// A signature with v outside {27,28} recovers address(0) and is rejected
    /// by OZ ECDSA.recover (ECDSAInvalidSignature).
    function testInvalidVSignatureRejected() public {
        _open();
        uint256 cumulative = 1_000_000;
        uint256 nonce = 1;
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, cumulative, nonce, recipient);
        // Corrupt v to 29 (invalid).
        sig[64] = bytes1(uint8(29));
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        channel.updateBalance(CHANNEL_ID, cumulative, nonce, recipient, sig);
    }

    // =====================================================================
    // #3 — deposit() funder-guard: a non-funder top-up reverts.
    // =====================================================================

    function testDepositByNonFunderReverts() public {
        _open();
        // The remainder always returns to ch.funder, so a third-party top-up
        // would be an irretrievable donation. The guard blocks it.
        vm.prank(attacker);
        vm.expectRevert(RollingSwapChannel.NotFunder.selector);
        channel.deposit(CHANNEL_ID, 1_000e6);

        // Deposit funds are untouched; attacker keeps their balance.
        assertEq(token.balanceOf(attacker), DEPOSIT, "attacker not charged");
        (,,,, uint256 dep,,) = channel.channels(CHANNEL_ID);
        assertEq(dep, DEPOSIT, "deposit unchanged by rejected top-up");
    }

    function testDepositByFunderStillWorks() public {
        _open();
        vm.prank(funder);
        channel.deposit(CHANNEL_ID, 25_000e6);
        (,,,, uint256 dep,,) = channel.channels(CHANNEL_ID);
        assertEq(dep, DEPOSIT + 25_000e6, "funder top-up credited");
    }

    // =====================================================================
    // #9c — channelId squat / open griefing.
    // =====================================================================

    /// An attacker who front-runs a victim's openChannel with the same
    /// channelId (but the attacker's own signer/deposit) permanently blocks the
    /// victim from opening that id: the second open reverts ChannelExists. This
    /// documents a griefing surface (channelIds are caller-chosen and first-come
    /// first-served); mitigation is choosing unpredictable channelIds off-chain.
    function testChannelIdSquatBlocksVictimOpen() public {
        // Attacker pre-opens the victim's intended channelId.
        vm.prank(attacker);
        channel.openChannel(CHANNEL_ID, attacker, 1e6);

        // Victim's open of the same id now reverts.
        vm.prank(funder);
        vm.expectRevert(RollingSwapChannel.ChannelExists.selector);
        channel.openChannel(CHANNEL_ID, signerAddr, DEPOSIT);

        // The squatted channel is controlled by the attacker's signer, not the
        // victim's — the victim gains nothing and must pick a fresh id.
        (address s, address f,,,,,) = channel.channels(CHANNEL_ID);
        assertEq(s, attacker);
        assertEq(f, attacker);
    }

    // =====================================================================
    // #9d — cooperativeClose InsufficientDeposit branch.
    // =====================================================================

    function testCooperativeCloseInsufficientDepositReverts() public {
        _open();
        uint256 cumulative = DEPOSIT + 1; // delta exceeds the deposit
        uint256 nonce = 1;
        bytes memory signerSig = _signClaim(signerPk, CHANNEL_ID, cumulative, nonce, recipient);
        bytes memory recipSig = _signCoopClose(recipientPk, CHANNEL_ID, cumulative, nonce);
        vm.expectRevert(RollingSwapChannel.InsufficientDeposit.selector);
        channel.cooperativeClose(CHANNEL_ID, cumulative, nonce, recipient, signerSig, recipSig);
    }

    // =====================================================================
    // #9e — cooperativeClose is callable from the Closing state.
    // =====================================================================

    function testCooperativeCloseFromClosingState() public {
        _open();
        // Move the channel into Closing via a unilateral close.
        vm.prank(funder);
        channel.initiateClose(CHANNEL_ID);
        (,,,,,, RollingSwapChannel.ChannelState st0) = channel.channels(CHANNEL_ID);
        assertEq(uint256(st0), uint256(RollingSwapChannel.ChannelState.Closing));

        // Cooperative close short-circuits the challenge window from Closing.
        uint256 cumulative = 10_000_000;
        uint256 nonce = 10;
        bytes memory signerSig = _signClaim(signerPk, CHANNEL_ID, cumulative, nonce, recipient);
        bytes memory recipSig = _signCoopClose(recipientPk, CHANNEL_ID, cumulative, nonce);

        uint256 funderBefore = token.balanceOf(funder);
        channel.cooperativeClose(CHANNEL_ID, cumulative, nonce, recipient, signerSig, recipSig);

        assertEq(token.balanceOf(recipient), cumulative, "recipient paid final watermark");
        assertEq(token.balanceOf(funder), funderBefore + (DEPOSIT - cumulative), "funder refunded remainder");
        (,,,, uint256 dep,, RollingSwapChannel.ChannelState st1) = channel.channels(CHANNEL_ID);
        assertEq(dep, 0);
        assertEq(uint256(st1), uint256(RollingSwapChannel.ChannelState.Closed));
    }

    // =====================================================================
    // #9f — fee-on-transfer on the deposit() top-up path credits net received.
    // =====================================================================

    function testFeeOnTransferDepositTopUpCreditsNet() public {
        MockERC20WithFee feeToken = new MockERC20WithFee("Fee", "FEE", 6, 10); // 10% fee
        RollingSwapChannel feeChannel = new RollingSwapChannel(address(feeToken), CHALLENGE);
        feeToken.transfer(funder, DEPOSIT * 2);

        vm.startPrank(funder);
        feeToken.approve(address(feeChannel), type(uint256).max);
        feeChannel.openChannel(CHANNEL_ID, signerAddr, 100_000e6); // credits 90k net
        (,,,, uint256 depAfterOpen,,) = feeChannel.channels(CHANNEL_ID);
        assertEq(depAfterOpen, 90_000e6, "open credits net-of-fee");

        // Top up 50k gross -> 45k net credited (fee-on-transfer safe).
        feeChannel.deposit(CHANNEL_ID, 50_000e6);
        vm.stopPrank();

        (,,,, uint256 depAfterTopUp,,) = feeChannel.channels(CHANNEL_ID);
        assertEq(depAfterTopUp, 90_000e6 + 45_000e6, "top-up credits net-of-fee received amount");
    }

    // =====================================================================
    // #1 — cross-deployment replay. KNOWN LIMITATION, documented not fixed.
    // =====================================================================

    /// KNOWN LIMITATION (finding #1): digest lacks chainId/address domain
    /// separation — see tracking issue. A single signer operating the SAME
    /// channelId across two deployments lets ONE off-chain signature pay out on
    /// BOTH contracts (same recipient). This test asserts the CURRENT vulnerable
    /// behavior so the eventual fix (adding chainId/address to the preimage,
    /// which is ABI-breaking and coordinated with the sdk/client/swap signer)
    /// deliberately flips this assertion. Do NOT "fix" it here.
    function testCrossDeploymentReplayIsCurrentlyPossible() public {
        RollingSwapChannel chanA = new RollingSwapChannel(address(token), CHALLENGE);
        RollingSwapChannel chanB = new RollingSwapChannel(address(token), CHALLENGE);

        token.transfer(funder, DEPOSIT * 2);
        vm.startPrank(funder);
        token.approve(address(chanA), type(uint256).max);
        token.approve(address(chanB), type(uint256).max);
        // Same channelId + same signer provisioned on both deployments.
        chanA.openChannel(CHANNEL_ID, signerAddr, DEPOSIT);
        chanB.openChannel(CHANNEL_ID, signerAddr, DEPOSIT);
        vm.stopPrank();

        // Signer issues ONE claim (intended for deployment A only).
        uint256 cum = 40_000e6;
        bytes memory sig = _signClaim(signerPk, CHANNEL_ID, cum, 1, recipient);

        chanA.updateBalance(CHANNEL_ID, cum, 1, recipient, sig);
        // Replaying the SAME signature on B currently SUCCEEDS (the bug).
        chanB.updateBalance(CHANNEL_ID, cum, 1, recipient, sig);

        assertEq(token.balanceOf(recipient), cum * 2, "one signature paid out on TWO deployments (finding #1)");
    }
}
