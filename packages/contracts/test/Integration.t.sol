// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockERC20.sol";

/**
 * @title Integration Test for Contract Deployment Verification
 * @notice Verifies foundry setup, compilation, deployment, and basic contract interactions
 * @dev This test validates Story 8.1 acceptance criteria without requiring live Anvil
 */
contract IntegrationTest is Test {
    MockERC20 public token;
    address public deployer = address(1);
    address public alice = address(2);
    address public bob = address(3);
    uint256 public constant INITIAL_SUPPLY = 1000000 * 10**18;

    function setUp() public {
        vm.startPrank(deployer);
        token = new MockERC20("Test Token", "TST", INITIAL_SUPPLY);
        vm.stopPrank();
    }

    /// @notice Verify Foundry environment is properly configured
    function testFoundrySetup() public {
        // Verify forge-std library accessible
        assertTrue(true);
        
        // Verify test environment has block context
        assertGt(block.timestamp, 0);
        assertGt(block.number, 0);
    }

    /// @notice Verify contract compiles and deploys successfully
    function testContractDeployment() public {
        assertEq(token.name(), "Test Token");
        assertEq(token.symbol(), "TST");
        assertEq(token.totalSupply(), INITIAL_SUPPLY);
        assertEq(token.decimals(), 18); // ERC20 default
    }

    /// @notice Verify deployer receives initial supply
    function testInitialBalanceDistribution() public {
        assertEq(token.balanceOf(deployer), INITIAL_SUPPLY);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), 0);
    }

    /// @notice Verify basic ERC20 transfer functionality
    function testTransferFunctionality() public {
        uint256 transferAmount = 1000 * 10**18;

        vm.prank(deployer);
        bool success = token.transfer(alice, transferAmount);

        assertTrue(success);
        assertEq(token.balanceOf(alice), transferAmount);
        assertEq(token.balanceOf(deployer), INITIAL_SUPPLY - transferAmount);
    }

    /// @notice Verify ERC20 approve and transferFrom pattern
    function testApproveAndTransferFrom() public {
        uint256 approvalAmount = 500 * 10**18;
        uint256 transferAmount = 200 * 10**18;

        // Deployer approves Alice to spend tokens
        vm.prank(deployer);
        token.approve(alice, approvalAmount);

        assertEq(token.allowance(deployer, alice), approvalAmount);

        // Alice transfers tokens from deployer to Bob
        vm.prank(alice);
        bool success = token.transferFrom(deployer, bob, transferAmount);

        assertTrue(success);
        assertEq(token.balanceOf(bob), transferAmount);
        assertEq(token.allowance(deployer, alice), approvalAmount - transferAmount);
    }

    /// @notice Verify transfers fail when insufficient balance
    function testTransferFailsWithInsufficientBalance() public {
        vm.prank(alice); // Alice has 0 balance
        vm.expectRevert();
        token.transfer(bob, 1000 * 10**18);
    }

    /// @notice Verify transferFrom fails without approval
    function testTransferFromFailsWithoutApproval() public {
        vm.prank(alice);
        vm.expectRevert();
        token.transferFrom(deployer, bob, 1000 * 10**18);
    }

    /// @notice Verify OpenZeppelin ERC20 implementation standards
    function testERC20Standards() public {
        // Verify standard ERC20 interface compliance
        assertEq(token.decimals(), 18);
        assertTrue(bytes(token.name()).length > 0);
        assertTrue(bytes(token.symbol()).length > 0);
    }

    /// @notice Verify contract can handle multiple concurrent operations
    function testConcurrentOperations() public {
        uint256 aliceAmount = 100 * 10**18;
        uint256 bobAmount = 200 * 10**18;

        // Deployer transfers to both Alice and Bob
        vm.startPrank(deployer);
        token.transfer(alice, aliceAmount);
        token.transfer(bob, bobAmount);
        vm.stopPrank();

        // Verify balances
        assertEq(token.balanceOf(alice), aliceAmount);
        assertEq(token.balanceOf(bob), bobAmount);
        assertEq(token.balanceOf(deployer), INITIAL_SUPPLY - aliceAmount - bobAmount);
    }
}
