// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TokenNetwork.sol";
import "../src/TokenNetworkRegistry.sol";
import "./mocks/MockERC20.sol";

/// @title TokenNetworkGasTest
/// @notice Gas benchmarking tests for TokenNetwork operations
/// @dev Measures gas costs against targets from Story 8.6 AC5
contract TokenNetworkGasTest is Test {
    TokenNetworkRegistry public registry;
    TokenNetwork public tokenNetwork;
    MockERC20 public token;

    address public alice;
    address public bob;

    uint256 public alicePrivateKey;
    uint256 public bobPrivateKey;

    // Gas targets from Story 8.6 AC5
    uint256 constant TARGET_OPEN_CHANNEL = 150_000;
    uint256 constant TARGET_DEPOSIT = 80_000;
    uint256 constant TARGET_CLOSE_CHANNEL = 100_000;
    uint256 constant TARGET_SETTLE_CHANNEL = 80_000;
    uint256 constant TARGET_COOPERATIVE_SETTLE = 120_000;
    uint256 constant TARGET_WITHDRAW = 70_000;

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

        alice = vm.addr(alicePrivateKey);
        bob = vm.addr(bobPrivateKey);

        // Fund test accounts
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);

        // Mint tokens to test accounts
        token.transfer(alice, 100000 * 10 ** 18);
        token.transfer(bob, 100000 * 10 ** 18);
    }

    /// @notice Gas benchmark: openChannel operation
    /// @dev Target: <150k gas
    function testGas_OpenChannel() public {
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);
        uint256 gasUsed = gasBefore - gasleft();

        console.log("Gas used for openChannel:", gasUsed);
        assertTrue(channelId != bytes32(0), "Channel should be created");
        assertLt(gasUsed, TARGET_OPEN_CHANNEL, "openChannel gas cost exceeds target");
    }

    /// @notice Gas benchmark: setTotalDeposit operation
    /// @dev Target: <80k gas
    function testGas_Deposit() public {
        // Setup: Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        // Measure deposit gas cost
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        uint256 gasBefore = gasleft();
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        uint256 gasUsed = gasBefore - gasleft();
        vm.stopPrank();

        console.log("Gas used for setTotalDeposit:", gasUsed);
        assertLt(gasUsed, TARGET_DEPOSIT, "setTotalDeposit gas cost exceeds target");
    }

    /// @notice Gas benchmark: closeChannel operation
    /// @dev Target: <100k gas
    function testGas_CloseChannel() public {
        // Setup: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Create and sign balance proof
        TokenNetwork.BalanceProof memory proof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });
        bytes memory signature = signBalanceProof(alicePrivateKey, channelId, 1, 100 * 10 ** 18, 0, bytes32(0));

        // Measure close gas cost
        vm.prank(bob);
        uint256 gasBefore = gasleft();
        tokenNetwork.closeChannel(channelId, proof, signature);
        uint256 gasUsed = gasBefore - gasleft();

        console.log("Gas used for closeChannel:", gasUsed);
        assertLt(gasUsed, TARGET_CLOSE_CHANNEL, "closeChannel gas cost exceeds target");
    }

    /// @notice Gas benchmark: settleChannel operation
    /// @dev Target: <80k gas
    function testGas_SettleChannel() public {
        // Setup: Open, deposit, close channel
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

        // Close channel
        TokenNetwork.BalanceProof memory proof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });
        bytes memory signature = signBalanceProof(alicePrivateKey, channelId, 1, 100 * 10 ** 18, 0, bytes32(0));

        vm.prank(bob);
        tokenNetwork.closeChannel(channelId, proof, signature);

        // Fast forward past challenge period
        vm.warp(block.timestamp + 1 hours + 1);

        // Measure settle gas cost
        uint256 gasBefore = gasleft();
        tokenNetwork.settleChannel(channelId);
        uint256 gasUsed = gasBefore - gasleft();

        console.log("Gas used for settleChannel:", gasUsed);
        assertLt(gasUsed, TARGET_SETTLE_CHANNEL, "settleChannel gas cost exceeds target");
    }

    /// @notice Gas benchmark: cooperativeSettle operation
    /// @dev Target: <120k gas (cheaper than unilateral close + settle ~180k)
    function testGas_CooperativeSettle() public {
        // Setup: Open channel and deposit
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

        // Create balance proofs for both participants
        TokenNetwork.BalanceProof memory aliceProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 250 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: 150 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes memory aliceSig = signBalanceProof(alicePrivateKey, channelId, 1, 250 * 10 ** 18, 0, bytes32(0));
        bytes memory bobSig = signBalanceProof(bobPrivateKey, channelId, 1, 150 * 10 ** 18, 0, bytes32(0));

        // Measure cooperative settle gas cost
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        tokenNetwork.cooperativeSettle(channelId, aliceProof, aliceSig, bobProof, bobSig);
        uint256 gasUsed = gasBefore - gasleft();

        console.log("Gas used for cooperativeSettle:", gasUsed);
        assertLt(gasUsed, TARGET_COOPERATIVE_SETTLE, "cooperativeSettle gas cost exceeds target");
    }

    /// @notice Gas benchmark: withdraw operation
    /// @dev Target: <70k gas
    function testGas_Withdraw() public {
        // Setup: Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), 1000 * 10 ** 18);
        tokenNetwork.setTotalDeposit(channelId, alice, 1000 * 10 ** 18);
        vm.stopPrank();

        // Create withdrawal proof signed by Bob
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

        // Measure withdraw gas cost
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        tokenNetwork.withdraw(channelId, withdrawnAmount, withdrawNonce, bobWithdrawSig);
        uint256 gasUsed = gasBefore - gasleft();

        console.log("Gas used for withdraw:", gasUsed);
        assertLt(gasUsed, TARGET_WITHDRAW, "withdraw gas cost exceeds target");
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
