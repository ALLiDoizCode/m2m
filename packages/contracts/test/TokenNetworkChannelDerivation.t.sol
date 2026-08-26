// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TokenNetwork.sol";
import "./mocks/MockERC20.sol";

/// @title TokenNetworkChannelDerivationTest
/// @notice A channel's identifier is derived from its participants (ADR 0059, issue #1158).
/// @dev Three properties, and nothing here reads an event log or a reverse index -- every
///      derivation below is built from the two participant addresses and the `channelEpoch`
///      public getter, which is exactly what an off-chain party has:
///
///      1. derive-and-open: the id `openChannel` returns is the one the pair derives beforehand,
///         in either argument order;
///      2. reopen after settle: settlement advances the pair's epoch, so the pair derives a fresh,
///         unused id and can open again;
///      3. a second open on a live pair reverts. `ChannelAlreadyExists` was dead code under the
///         old global `channelCounter` (a fresh counter made a collision impossible); it is a live
///         refusal now, and this is the test that says so.
///
///      The token is implicit in the contract address: `TokenNetworkRegistry` deploys one
///      `TokenNetwork` per token, so "one live channel per pair" here means one per pair per token.
contract TokenNetworkChannelDerivationTest is Test {
    TokenNetwork public tokenNetwork;
    MockERC20 public token;

    address public alice;
    address public bob;
    address public charlie;

    function setUp() public {
        token = new MockERC20("Test Token", "TEST", 18);
        tokenNetwork = new TokenNetwork(address(token), 1_000_000 * 10 ** 18, 365 days, address(0));

        alice = vm.addr(0xA11CE);
        bob = vm.addr(0xB0B);
        charlie = vm.addr(0xC0C);

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);

        token.transfer(alice, 10_000 * 10 ** 18);
        token.transfer(bob, 10_000 * 10 ** 18);
        token.transfer(charlie, 10_000 * 10 ** 18);
    }

    /// @notice The whole derivation an off-chain party performs: sort, read the pair's epoch, hash.
    function derive(address a, address b) internal view returns (bytes32) {
        (address p1, address p2) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(p1, p2, tokenNetwork.channelEpoch(p1, p2)));
    }

    function channelState(bytes32 channelId) internal view returns (TokenNetwork.ChannelState) {
        (, TokenNetwork.ChannelState state,,,,) = tokenNetwork.channels(channelId);
        return state;
    }

    function closeAndSettle(address closer, bytes32 channelId) internal {
        vm.prank(closer);
        tokenNetwork.closeChannel(channelId);
        vm.warp(block.timestamp + 1 hours + 1);
        tokenNetwork.settleChannel(channelId);
    }

    // ===== 1. Derive and open =====

    /// @notice A pair derives its channel id before the channel exists, and `openChannel` lands there.
    function testDerivedIdIsTheIdOpenChannelReturns() public {
        bytes32 derived = derive(alice, bob);

        // Absent before: the derivation answers "no channel" without any index to consult.
        assertEq(
            uint256(channelState(derived)),
            uint256(TokenNetwork.ChannelState.NonExistent),
            "a pair with no channel must derive an id nothing occupies"
        );

        vm.prank(alice);
        bytes32 opened = tokenNetwork.openChannel(bob, 1 hours);

        assertEq(opened, derived, "openChannel must land on the id the pair derives");
        assertEq(
            uint256(channelState(derived)),
            uint256(TokenNetwork.ChannelState.Opened),
            "the derived id must now be found, and Opened"
        );
    }

    /// @notice Either party derives the same id, and it does not depend on who called `openChannel`.
    function testDerivationIsIndependentOfArgumentOrder() public {
        assertEq(derive(alice, bob), derive(bob, alice), "the derivation must sort its pair");

        vm.prank(bob);
        bytes32 opened = tokenNetwork.openChannel(alice, 1 hours);
        assertEq(opened, derive(alice, bob), "the opener's argument order must not move the id");
    }

    /// @notice Two different pairs derive two different ids on the same TokenNetwork.
    function testADifferentPairDerivesADifferentId() public {
        vm.prank(alice);
        bytes32 ab = tokenNetwork.openChannel(bob, 1 hours);
        vm.prank(alice);
        bytes32 ac = tokenNetwork.openChannel(charlie, 1 hours);

        assertTrue(ab != ac, "distinct pairs must hold distinct channels");
        assertEq(ab, derive(alice, bob), "alice-bob");
        assertEq(ac, derive(alice, charlie), "alice-charlie");
        assertEq(
            uint256(channelState(derive(bob, charlie))),
            uint256(TokenNetwork.ChannelState.NonExistent),
            "a pair that never opened must still derive an absent id"
        );
    }

    // ===== 2. Reopen after settle, with the epoch advanced =====

    /// @notice Settlement advances the pair's epoch, so the pair can open again at a fresh id.
    function testReopenAfterSettleDerivesTheNextEpochsId() public {
        (address p1, address p2) = alice < bob ? (alice, bob) : (bob, alice);
        assertEq(tokenNetwork.channelEpoch(p1, p2), 0, "a fresh pair starts at epoch 0");

        vm.prank(alice);
        bytes32 first = tokenNetwork.openChannel(bob, 1 hours);
        assertEq(first, keccak256(abi.encodePacked(p1, p2, uint256(0))), "epoch 0 id");

        closeAndSettle(alice, first);

        assertEq(
            uint256(channelState(first)),
            uint256(TokenNetwork.ChannelState.Settled),
            "the first channel must be Settled"
        );
        assertEq(tokenNetwork.channelEpoch(p1, p2), 1, "settlement must advance the pair's epoch");

        // The pair now derives a *different* id, and it is free.
        bytes32 next = derive(alice, bob);
        assertEq(next, keccak256(abi.encodePacked(p1, p2, uint256(1))), "epoch 1 id");
        assertTrue(next != first, "a reopened channel must not reuse the settled id");

        vm.prank(alice);
        bytes32 second = tokenNetwork.openChannel(bob, 1 hours);
        assertEq(second, next, "the reopen must land on the derived epoch-1 id");
        assertEq(
            uint256(channelState(second)),
            uint256(TokenNetwork.ChannelState.Opened),
            "the reopened channel must be Opened"
        );

        // And it settles too, so this is a cycle rather than one extra life.
        closeAndSettle(alice, second);
        assertEq(tokenNetwork.channelEpoch(p1, p2), 2, "each settlement advances the epoch once");
        vm.prank(alice);
        bytes32 third = tokenNetwork.openChannel(bob, 1 hours);
        assertEq(third, keccak256(abi.encodePacked(p1, p2, uint256(2))), "epoch 2 id");
    }

    /// @notice One pair settling leaves every other pair's epoch, and therefore id, untouched.
    function testSettlementAdvancesOnlyTheSettlingPairsEpoch() public {
        vm.prank(alice);
        bytes32 ac = tokenNetwork.openChannel(charlie, 1 hours);
        bytes32 bcBefore = derive(bob, charlie);

        vm.prank(alice);
        bytes32 ab = tokenNetwork.openChannel(bob, 1 hours);
        closeAndSettle(alice, ab);

        (address q1, address q2) = alice < charlie ? (alice, charlie) : (charlie, alice);
        assertEq(tokenNetwork.channelEpoch(q1, q2), 0, "an untouched pair stays at epoch 0");
        assertEq(ac, derive(alice, charlie), "a live channel's id must not move under another pair's settlement");
        assertEq(bcBefore, derive(bob, charlie), "an unopened pair's derivation must not move either");
    }

    // ===== 3. A second open on a live pair reverts =====

    /// @notice At most one Opened channel per pair.
    function testSecondOpenOnAnOpenedPairReverts() public {
        vm.prank(alice);
        tokenNetwork.openChannel(bob, 1 hours);

        vm.prank(alice);
        vm.expectRevert(TokenNetwork.ChannelAlreadyExists.selector);
        tokenNetwork.openChannel(bob, 1 hours);
    }

    /// @notice The refusal does not depend on which side asks for the second channel.
    function testSecondOpenFromTheOtherSideRevertsToo() public {
        vm.prank(alice);
        tokenNetwork.openChannel(bob, 1 hours);

        vm.prank(bob);
        vm.expectRevert(TokenNetwork.ChannelAlreadyExists.selector);
        tokenNetwork.openChannel(alice, 1 hours);
    }

    /// @notice A Closed-but-unsettled channel is still live: the epoch has not moved, so the pair
    ///         has no free id and a reopen is refused until the money is actually distributed.
    function testSecondOpenWhileTheFirstIsClosedButNotSettledReverts() public {
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.prank(alice);
        tokenNetwork.closeChannel(channelId);
        assertEq(
            uint256(channelState(channelId)),
            uint256(TokenNetwork.ChannelState.Closed),
            "the channel must be Closed, not Settled"
        );

        vm.prank(alice);
        vm.expectRevert(TokenNetwork.ChannelAlreadyExists.selector);
        tokenNetwork.openChannel(bob, 1 hours);
    }

    /// @notice A force-closed (expired) channel is Closed too, and refuses a reopen for the same
    ///         reason -- `forceCloseExpiredChannel` does not settle and does not advance the epoch.
    function testSecondOpenAfterAForceCloseButBeforeSettlementReverts() public {
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.warp(block.timestamp + 366 days);
        tokenNetwork.forceCloseExpiredChannel(channelId);

        vm.prank(alice);
        vm.expectRevert(TokenNetwork.ChannelAlreadyExists.selector);
        tokenNetwork.openChannel(bob, 1 hours);

        // Settling it is what frees the pair, force-closed or not.
        vm.warp(block.timestamp + 1 hours + 1);
        tokenNetwork.settleChannel(channelId);
        vm.prank(alice);
        bytes32 reopened = tokenNetwork.openChannel(bob, 1 hours);
        assertTrue(reopened != channelId, "a force-closed channel that settled frees a fresh id");
    }

    /// @notice Deposits and claimed amounts follow the id, so a reopened channel starts empty --
    ///         the settled channel's balances stay under the id that earned them.
    function testAReopenedChannelStartsWithNoDepositOfItsOwn() public {
        vm.prank(alice);
        bytes32 first = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1_000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(first, alice, 1_000 * 10 ** 18);
        vm.stopPrank();

        closeAndSettle(alice, first);

        vm.prank(alice);
        bytes32 second = tokenNetwork.openChannel(bob, 1 hours);
        (uint256 deposit,,) = tokenNetwork.participants(second, alice);
        assertEq(deposit, 0, "a reopened channel carries none of the settled channel's collateral");

        (uint256 settledDeposit,,) = tokenNetwork.participants(first, alice);
        assertEq(settledDeposit, 1_000 * 10 ** 18, "the settled channel's own record is left alone");
    }
}
