// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockERC20.sol";

contract DeployTest is Test {
    MockERC20 public token;
    address public deployer = address(1);
    uint256 public initialSupply = 1000000 * 10 ** 18;

    function setUp() public {
        vm.startPrank(deployer);
        token = new MockERC20("Test Token", "TST", initialSupply);
        vm.stopPrank();
    }

    function testDeployment() public {
        // Verify token deployed successfully
        assertEq(token.name(), "Test Token");
        assertEq(token.symbol(), "TST");
        assertEq(token.totalSupply(), initialSupply);
        assertEq(token.balanceOf(deployer), initialSupply);
    }

    function testTransfer() public {
        address recipient = address(2);
        uint256 amount = 1000 * 10 ** 18;

        vm.prank(deployer);
        token.transfer(recipient, amount);

        assertEq(token.balanceOf(recipient), amount);
        assertEq(token.balanceOf(deployer), initialSupply - amount);
    }
}
