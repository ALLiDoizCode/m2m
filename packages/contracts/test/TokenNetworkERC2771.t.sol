// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import "../src/TokenNetwork.sol";
import "../src/TokenNetworkRegistry.sol";
import "./mocks/MockERC20.sol";

/// @title TokenNetworkERC2771Test
/// @notice Proves TokenNetwork's ERC-2771 meta-transaction support (issue #694): an EOA holding
///         zero native gas can open/deposit/close/claim through a relayer-submitted forwarder
///         call, authenticated as itself (never as the relayer), and that a forwarded call cannot
///         be used to spoof another party's identity.
contract TokenNetworkERC2771Test is Test {
    ERC2771Forwarder public forwarder;
    TokenNetwork public tokenNetwork;
    MockERC20 public token;

    address public alice;
    address public bob;
    address public relayer;
    address public attacker;

    uint256 public alicePrivateKey;
    uint256 public bobPrivateKey;
    uint256 public attackerPrivateKey;

    bytes32 internal constant FORWARD_REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );

    function setUp() public {
        forwarder = new ERC2771Forwarder("TokenNetworkForwarder");
        token = new MockERC20("Test Token", "TEST", 18);
        tokenNetwork = new TokenNetwork(address(token), 1_000_000 * 10 ** 18, 365 days, address(forwarder));

        alicePrivateKey = 0xA11CE;
        bobPrivateKey = 0xB0B;
        attackerPrivateKey = 0xBAD;

        alice = vm.addr(alicePrivateKey);
        bob = vm.addr(bobPrivateKey);
        attacker = vm.addr(attackerPrivateKey);
        relayer = address(0x1234);

        // alice and bob hold zero native balance throughout -- only the relayer pays gas.
        vm.deal(relayer, 100 ether);
        vm.deal(attacker, 100 ether);

        token.transfer(alice, 10_000 * 10 ** 18);
        token.transfer(bob, 10_000 * 10 ** 18);
    }

    // ===== Helpers =====

    function _forwarderDomainSeparator() internal view returns (bytes32) {
        bytes32 typeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        return keccak256(
            abi.encode(
                typeHash, keccak256("TokenNetworkForwarder"), keccak256("1"), block.chainid, address(forwarder)
            )
        );
    }

    function _signForwardRequest(
        uint256 signerKey,
        address from,
        address to,
        uint256 gas,
        uint48 deadline,
        bytes memory data
    ) internal view returns (ERC2771Forwarder.ForwardRequestData memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                FORWARD_REQUEST_TYPEHASH, from, to, uint256(0), gas, forwarder.nonces(from), deadline, keccak256(data)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _forwarderDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        return ERC2771Forwarder.ForwardRequestData({
            from: from,
            to: to,
            value: 0,
            gas: gas,
            deadline: deadline,
            data: data,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function _executeForwarded(uint256 signerKey, address from, bytes memory data) internal {
        ERC2771Forwarder.ForwardRequestData memory request =
            _signForwardRequest(signerKey, from, address(tokenNetwork), 500_000, uint48(block.timestamp + 1 hours), data);

        // The relayer pays gas; the signer's balance never moves.
        vm.prank(relayer);
        forwarder.execute(request);
    }

    // ===== Deployability =====

    function testForwarderIsDeployedAndTrusted() public view {
        assertTrue(address(forwarder) != address(0), "forwarder should deploy");
        assertTrue(tokenNetwork.isTrustedForwarder(address(forwarder)), "TokenNetwork should trust the forwarder");
    }

    // ===== Gasless lifecycle: open -> deposit -> close -> settle =====

    function testGaslessOpenChannel() public {
        assertEq(alice.balance, 0, "alice must hold zero native gas");
        assertEq(bob.balance, 0, "bob must hold zero native gas");

        bytes memory data = abi.encodeCall(TokenNetwork.openChannel, (bob, 1 hours));
        _executeForwarded(alicePrivateKey, alice, data);

        (address p1, address p2) = alice < bob ? (alice, bob) : (bob, alice);
        bytes32 channelId = keccak256(abi.encodePacked(p1, p2, uint256(0)));

        (, TokenNetwork.ChannelState state,,, address participant1, address participant2) =
            tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Opened), "channel should be opened");
        assertTrue(
            (participant1 == alice && participant2 == bob) || (participant1 == bob && participant2 == alice),
            "participants should be alice and bob, not the relayer"
        );

        // alice paid zero gas -- her native balance is untouched.
        assertEq(alice.balance, 0, "alice should still hold zero native gas after opening a channel");
    }

    function testGaslessDepositPullsFromSignerNotForwarder() public {
        bytes memory openData = abi.encodeCall(TokenNetwork.openChannel, (bob, 1 hours));
        _executeForwarded(alicePrivateKey, alice, openData);

        (address p1, address p2) = alice < bob ? (alice, bob) : (bob, alice);
        bytes32 channelId = keccak256(abi.encodePacked(p1, p2, uint256(0)));

        // alice approves the TokenNetwork directly (an ERC20 approval needs no gas-station help
        // to reason about here -- it is the deposit call itself that must be gasless/forwardable).
        vm.prank(alice);
        token.approve(address(tokenNetwork), 1_000 * 10 ** 18);

        uint256 relayerBalanceBefore = token.balanceOf(relayer);

        bytes memory depositData = abi.encodeCall(TokenNetwork.setTotalDeposit, (channelId, alice, 1_000 * 10 ** 18));
        _executeForwarded(alicePrivateKey, alice, depositData);

        (uint256 depositAmount,,) = tokenNetwork.participants(channelId, alice);
        assertEq(depositAmount, 1_000 * 10 ** 18, "alice's deposit should be recorded");
        assertEq(token.balanceOf(relayer), relayerBalanceBefore, "the relayer's own tokens must never move");
    }

    function testGaslessCloseChannel() public {
        bytes memory openData = abi.encodeCall(TokenNetwork.openChannel, (bob, 1 hours));
        _executeForwarded(alicePrivateKey, alice, openData);

        (address p1, address p2) = alice < bob ? (alice, bob) : (bob, alice);
        bytes32 channelId = keccak256(abi.encodePacked(p1, p2, uint256(0)));

        bytes memory closeData = abi.encodeCall(TokenNetwork.closeChannel, (channelId));
        _executeForwarded(bobPrivateKey, bob, closeData);

        (, TokenNetwork.ChannelState state,,,,) = tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Closed), "channel should be closed by bob");
        assertEq(bob.balance, 0, "bob should still hold zero native gas after closing a channel");
    }

    function testSettleIsAlreadyPermissionlessAndNeedsNoForwarding() public {
        // settleChannel performs no identity check today -- proving the relayer can call it
        // directly (no forwarding required) completes the gasless settle/close/deposit lifecycle
        // the acceptance criteria describes.
        bytes memory openData = abi.encodeCall(TokenNetwork.openChannel, (bob, 1 hours));
        _executeForwarded(alicePrivateKey, alice, openData);

        (address p1, address p2) = alice < bob ? (alice, bob) : (bob, alice);
        bytes32 channelId = keccak256(abi.encodePacked(p1, p2, uint256(0)));

        bytes memory closeData = abi.encodeCall(TokenNetwork.closeChannel, (channelId));
        _executeForwarded(alicePrivateKey, alice, closeData);

        vm.warp(block.timestamp + 1 hours + 1);

        vm.prank(relayer);
        tokenNetwork.settleChannel(channelId);

        (, TokenNetwork.ChannelState state,,,,) = tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Settled), "channel should be settled");
    }

    // ===== _msgSender() spoofing footgun =====

    function testDirectCallCannotSpoofIdentityViaAppendedSuffix() public {
        // The classic ERC-2771 footgun: an untrusted caller appends a victim's address to
        // calldata, hoping _msgSender() resolves to the victim. Since msg.sender (the attacker)
        // is not the trusted forwarder, TokenNetwork must fall back to the real msg.sender.
        bytes memory data = abi.encodeCall(TokenNetwork.openChannel, (bob, 1 hours));
        bytes memory spoofedData = abi.encodePacked(data, alice);

        vm.prank(attacker);
        (bool success,) = address(tokenNetwork).call(spoofedData);
        assertTrue(success, "the call itself should still succeed");

        // The channel must be between the attacker and bob -- NOT alice and bob.
        (address p1, address p2) = attacker < bob ? (attacker, bob) : (bob, attacker);
        bytes32 attackerChannelId = keccak256(abi.encodePacked(p1, p2, uint256(0)));
        (, TokenNetwork.ChannelState attackerState,,, address participant1, address participant2) =
            tokenNetwork.channels(attackerChannelId);
        assertEq(uint256(attackerState), uint256(TokenNetwork.ChannelState.Opened), "attacker's own channel opened");
        assertTrue(
            (participant1 == attacker && participant2 == bob) || (participant1 == bob && participant2 == attacker),
            "the spoofed suffix must not substitute alice for the real caller"
        );

        // No channel should exist between alice and bob -- the spoof must not have landed.
        (address ap1, address ap2) = alice < bob ? (alice, bob) : (bob, alice);
        bytes32 aliceChannelId = keccak256(abi.encodePacked(ap1, ap2, uint256(0)));
        (, TokenNetwork.ChannelState aliceState,,,,) = tokenNetwork.channels(aliceChannelId);
        assertEq(
            uint256(aliceState),
            uint256(TokenNetwork.ChannelState.NonExistent),
            "no channel should have opened on alice's behalf"
        );
    }

    function testUntrustedForwarderCannotForgeIdentity() public {
        // A second forwarder that TokenNetwork does NOT trust must not be able to move funds
        // out from under alice even if it faithfully implements the ERC-2771 suffix convention.
        ERC2771Forwarder untrustedForwarder = new ERC2771Forwarder("RogueForwarder");
        assertFalse(
            tokenNetwork.isTrustedForwarder(address(untrustedForwarder)), "TokenNetwork must not trust this forwarder"
        );

        bytes memory data = abi.encodeCall(TokenNetwork.openChannel, (bob, 1 hours));
        bytes32 structHash = keccak256(
            abi.encode(
                FORWARD_REQUEST_TYPEHASH,
                alice,
                address(tokenNetwork),
                uint256(0),
                uint256(500_000),
                untrustedForwarder.nonces(alice),
                uint48(block.timestamp + 1 hours),
                keccak256(data)
            )
        );
        bytes32 typeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 domainSeparator = keccak256(
            abi.encode(typeHash, keccak256("RogueForwarder"), keccak256("1"), block.chainid, address(untrustedForwarder))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePrivateKey, digest);

        ERC2771Forwarder.ForwardRequestData memory request = ERC2771Forwarder.ForwardRequestData({
            from: alice,
            to: address(tokenNetwork),
            value: 0,
            gas: 500_000,
            deadline: uint48(block.timestamp + 1 hours),
            data: data,
            signature: abi.encodePacked(r, s, v)
        });

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ERC2771Forwarder.ERC2771UntrustfulTarget.selector, address(tokenNetwork), address(untrustedForwarder))
        );
        untrustedForwarder.execute(request);
    }
}
