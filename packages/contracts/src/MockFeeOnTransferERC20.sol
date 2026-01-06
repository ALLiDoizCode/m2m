// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MockERC20.sol";

/**
 * @title MockFeeOnTransferERC20
 * @notice Mock ERC20 token that charges 10% fee on transfers
 * @dev Used to test fee-on-transfer token handling in TokenNetwork
 *      Deducts 10% of transferred amount and burns it
 */
contract MockFeeOnTransferERC20 is MockERC20 {
    /**
     * @notice Creates a MockFeeOnTransferERC20 with name "Fee Token" and symbol "FEE"
     */
    constructor() MockERC20("Fee Token", "FEE", 18) {}

    /**
     * @notice Transfer with 10% fee
     * @dev Overrides ERC20 transferFrom to deduct 10% fee
     * @param from Source address
     * @param to Destination address
     * @param amount Amount to transfer (before fee)
     * @return Always returns true
     */
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        // Deduct 10% fee
        uint256 fee = amount / 10;
        uint256 actualAmount = amount - fee;

        // Transfer actual amount minus fee
        _transfer(from, to, actualAmount);

        // Burn the fee (simulate fee-on-transfer)
        if (fee > 0) {
            _burn(from, fee);
        }

        return true;
    }
}
