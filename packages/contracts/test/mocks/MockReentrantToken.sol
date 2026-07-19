// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

interface IReentrantTarget {
    function updateBalance(
        bytes32 channelId,
        uint256 cumulativeAmount,
        uint256 nonce,
        address recipient,
        bytes calldata signature
    ) external;
}

/// @title MockReentrantToken
/// @notice ERC20 whose `transfer` re-enters a target contract's
///         `updateBalance` when armed — used to prove the settlement
///         contract's re-entrancy guard blocks a recursive redeem.
contract MockReentrantToken is MockERC20 {
    IReentrantTarget public target;
    bool public armed;

    constructor() MockERC20("Reentrant", "REEN", 18) {}

    function setTarget(address _target) external {
        target = IReentrantTarget(_target);
    }

    function arm(bool _armed) external {
        armed = _armed;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed && address(target) != address(0)) {
            // Attempt a recursive redeem. The guard reverts at the modifier
            // (before any state check), and that revert bubbles up here,
            // failing the outer transfer and thus the outer updateBalance.
            armed = false; // avoid infinite recursion if the guard were absent
            target.updateBalance(bytes32(0), 0, 0, address(0), new bytes(65));
        }
        return super.transfer(to, amount);
    }
}
