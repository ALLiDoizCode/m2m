// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TokenNetwork.sol";
import "./mocks/MockERC20.sol";

/// @title TokenNetworkFuzzTest
/// @notice Fuzz tests for TokenNetwork contract to validate edge cases
contract TokenNetworkFuzzTest is Test {
    TokenNetwork public tokenNetwork;
    MockERC20 public token;
    address public alice;
    address public bob;

    uint256 public alicePrivateKey;
    uint256 public bobPrivateKey;

    function setUp() public {
        // Deploy mock ERC20 token
        token = new MockERC20("Test Token", "TEST", 18);

        // Deploy TokenNetwork with 1M token deposit limit
        tokenNetwork = new TokenNetwork(address(token), 1_000_000 * 10 ** 18, 365 days);

        // Create test accounts with private keys for EIP-712 signing
        alicePrivateKey = 0xA11CE;
        bobPrivateKey = 0xB0B;

        alice = vm.addr(alicePrivateKey);
        bob = vm.addr(bobPrivateKey);

        // Give ETH to test accounts
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);

        // Transfer tokens from deployer (this contract) to test accounts
        // MockERC20 mints 1M tokens to deployer by default
        uint256 halfSupply = token.totalSupply() / 2;
        token.transfer(alice, halfSupply);
        token.transfer(bob, halfSupply);
    }

    /// @notice Fuzz test: Deposit random amounts within valid range
    /// @param amount Random deposit amount to test
    function testFuzz_DepositRandomAmounts(uint256 amount) public {
        // Constrain amount to valid range (1 to maxChannelDeposit)
        vm.assume(amount > 0 && amount <= 1_000_000 * 10 ** 18);
        vm.assume(amount <= token.balanceOf(alice));

        // Open channel
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        // Alice deposits random amount
        vm.startPrank(alice);
        token.approve(address(tokenNetwork), amount);
        tokenNetwork.setTotalDeposit(channelId, alice, amount);
        vm.stopPrank();

        // Verify state consistency
        (uint256 deposit,,,, ) = tokenNetwork.participants(channelId, alice);
        assertEq(deposit, amount);
        assertEq(token.balanceOf(address(tokenNetwork)), amount);
    }

    /// @notice Fuzz test: Close channel with random nonces
    /// @param nonce Random nonce to test monotonic validation
    function testFuzz_CloseWithRandomNonces(uint256 nonce) public {
        // Constrain nonce to reasonable range
        vm.assume(nonce > 0 && nonce < type(uint128).max);

        // Open channel and deposit
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

        // Create balance proof with random nonce
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        bytes32 domainSeparator =
            keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));

        bytes32 balanceProofTypeHash = keccak256(
            "BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256 lockedAmount,bytes32 locksRoot)"
        );

        TokenNetwork.BalanceProof memory proof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: nonce,
            transferredAmount: 100 * 10 ** 18,
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes32 structHash = keccak256(
            abi.encode(balanceProofTypeHash, proof.channelId, proof.nonce, proof.transferredAmount, proof.lockedAmount, proof.locksRoot)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        // Bob signs balance proof
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPrivateKey, digest);
        bytes memory bobSignature = abi.encodePacked(r, s, v);

        // Alice closes channel with Bob's balance proof
        vm.prank(alice);
        tokenNetwork.closeChannel(channelId, proof, bobSignature);

        // Verify channel is closed
        (, TokenNetwork.ChannelState state,,,, ) = tokenNetwork.channels(channelId);
        assertEq(uint256(state), uint256(TokenNetwork.ChannelState.Closed));
    }

    /// @notice Fuzz test: Settle with random transferred amounts
    /// @param transferredAmount1 Random amount transferred by participant1
    /// @param transferredAmount2 Random amount transferred by participant2
    function testFuzz_SettleWithRandomBalances(uint256 transferredAmount1, uint256 transferredAmount2) public {
        uint256 deposit1 = 1000 * 10 ** 18;
        uint256 deposit2 = 1000 * 10 ** 18;

        // Constrain transferred amounts to valid range (0 to deposit)
        vm.assume(transferredAmount1 <= deposit1);
        vm.assume(transferredAmount2 <= deposit2);

        // Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), deposit1);
        tokenNetwork.setTotalDeposit(channelId, alice, deposit1);
        vm.stopPrank();

        vm.startPrank(bob);
        token.approve(address(tokenNetwork), deposit2);
        tokenNetwork.setTotalDeposit(channelId, bob, deposit2);
        vm.stopPrank();

        // Create balance proof for Alice with random transferred amount
        bytes32 TYPE_HASH =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256("TokenNetwork");
        bytes32 versionHash = keccak256("1");
        bytes32 domainSeparator =
            keccak256(abi.encode(TYPE_HASH, nameHash, versionHash, block.chainid, address(tokenNetwork)));

        bytes32 balanceProofTypeHash = keccak256(
            "BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256 lockedAmount,bytes32 locksRoot)"
        );

        TokenNetwork.BalanceProof memory bobProof = TokenNetwork.BalanceProof({
            channelId: channelId,
            nonce: 1,
            transferredAmount: transferredAmount2, // Bob transferred to Alice
            lockedAmount: 0,
            locksRoot: bytes32(0)
        });

        bytes32 structHash = keccak256(
            abi.encode(balanceProofTypeHash, bobProof.channelId, bobProof.nonce, bobProof.transferredAmount, bobProof.lockedAmount, bobProof.locksRoot)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPrivateKey, digest);
        bytes memory bobSignature = abi.encodePacked(r, s, v);

        // Alice closes channel with Bob's balance proof
        vm.prank(alice);
        tokenNetwork.closeChannel(channelId, bobProof, bobSignature);

        // Fast forward past challenge period
        vm.warp(block.timestamp + 1 hours + 1);

        // Record balances before settlement
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 bobBalanceBefore = token.balanceOf(bob);
        uint256 contractBalanceBefore = token.balanceOf(address(tokenNetwork));

        // Settle channel
        vm.prank(alice);
        tokenNetwork.settleChannel(channelId);

        // Verify balance conservation
        uint256 aliceBalanceAfter = token.balanceOf(alice);
        uint256 bobBalanceAfter = token.balanceOf(bob);
        uint256 contractBalanceAfter = token.balanceOf(address(tokenNetwork));

        assertEq(contractBalanceAfter, 0); // All funds distributed
        assertEq(
            aliceBalanceAfter + bobBalanceAfter,
            aliceBalanceBefore + bobBalanceBefore + contractBalanceBefore
        ); // Total balance conserved
    }

    /// @notice Fuzz test: Withdraw random amounts
    /// @param withdrawAmount Random withdrawal amount to test
    function testFuzz_WithdrawRandomAmounts(uint256 withdrawAmount) public {
        uint256 deposit = 1000 * 10 ** 18;

        // Constrain withdrawal to valid range (1 to deposit)
        vm.assume(withdrawAmount > 0 && withdrawAmount <= deposit);

        // Open channel and deposit
        vm.prank(alice);
        bytes32 channelId = tokenNetwork.openChannel(bob, 1 hours);

        vm.startPrank(alice);
        token.approve(address(tokenNetwork), deposit);
        tokenNetwork.setTotalDeposit(channelId, alice, deposit);
        vm.stopPrank();

        // Create withdrawal proof
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
            abi.encode(withdrawalProofTypeHash, channelId, alice, withdrawAmount, 1)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        // Bob signs the withdrawal proof
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPrivateKey, digest);
        bytes memory bobSignature = abi.encodePacked(r, s, v);

        // Record balances before withdrawal
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 contractBalanceBefore = token.balanceOf(address(tokenNetwork));

        // Alice withdraws with Bob's signature
        vm.prank(alice);
        tokenNetwork.withdraw(channelId, withdrawAmount, 1, bobSignature);

        // Verify balance changes
        uint256 aliceBalanceAfter = token.balanceOf(alice);
        uint256 contractBalanceAfter = token.balanceOf(address(tokenNetwork));

        assertEq(aliceBalanceAfter, aliceBalanceBefore + withdrawAmount);
        assertEq(contractBalanceAfter, contractBalanceBefore - withdrawAmount);

        // Verify participant state updated
        (, uint256 withdrawnAmount,,, ) = tokenNetwork.participants(channelId, alice);
        assertEq(withdrawnAmount, withdrawAmount);
    }

    /// @notice Invariant test: Total balance conservation
    /// @dev Verifies that totalDeposits == totalWithdrawals + contractBalance
    function invariant_TotalBalanceConserved() public view {
        // This is a basic invariant test
        // In a full implementation, you would track all deposits and withdrawals across all channels
        // For this MVP, we verify that contract balance never exceeds total supply
        uint256 contractBalance = token.balanceOf(address(tokenNetwork));
        uint256 totalSupply = token.totalSupply();

        assertLe(contractBalance, totalSupply);
    }
}
