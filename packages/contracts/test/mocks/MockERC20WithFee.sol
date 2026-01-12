// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

/// @title MockERC20WithFee
/// @notice Mock ERC20 token that charges a transfer fee (for testing fee-on-transfer token support)
contract MockERC20WithFee is MockERC20 {
    /// @notice Transfer fee percentage (10 = 10%)
    uint256 public feePercentage;

    /// @notice Deploy a mock ERC20 token with transfer fee
    /// @param name The token name
    /// @param symbol The token symbol
    /// @param decimals The token decimals
    /// @param _feePercentage The fee percentage (e.g., 10 for 10% fee)
    constructor(string memory name, string memory symbol, uint8 decimals, uint256 _feePercentage)
        MockERC20(name, symbol, decimals)
    {
        feePercentage = _feePercentage;
    }

    /// @notice Transfer tokens with fee deduction
    /// @param to The recipient address
    /// @param amount The amount to transfer (before fee)
    /// @return success True if transfer succeeded
    /// @dev Deducts fee from amount, transfers net amount to recipient, burns fee
    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");

        uint256 fee = (amount * feePercentage) / 100;
        uint256 netAmount = amount - fee;

        balanceOf[msg.sender] -= amount;
        balanceOf[to] += netAmount;
        totalSupply -= fee; // Burn the fee (simulates fee collection)

        emit Transfer(msg.sender, to, netAmount);
        return true;
    }

    /// @notice Transfer tokens from one address to another with fee deduction
    /// @param from The sender address
    /// @param to The recipient address
    /// @param amount The amount to transfer (before fee)
    /// @return success True if transfer succeeded
    /// @dev Deducts fee from amount, transfers net amount to recipient, burns fee
    function transferFrom(address from, address to, uint256 amount) public virtual override returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");

        uint256 fee = (amount * feePercentage) / 100;
        uint256 netAmount = amount - fee;

        balanceOf[from] -= amount;
        balanceOf[to] += netAmount;
        totalSupply -= fee; // Burn the fee (simulates fee collection)
        allowance[from][msg.sender] -= amount;

        emit Transfer(from, to, netAmount);
        return true;
    }
}
