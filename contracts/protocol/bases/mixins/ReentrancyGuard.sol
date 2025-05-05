// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

/**
 * @title ReentrancyGuard
 *
 * @notice Prevent reeentrancy on a facet function level
 */
contract ReentrancyGuard {
    uint256 internal constant GUARD_SLOT = 0;
    error Reentered();

    modifier nonReentrant() {
        // NB: it's more optimal to compare msg.sender to address(this) twice than storing it in a variable (e.g. _isSelf)
        // - it's cheaper
        // - it does not add a variable to the stack and cause stack too deep errors
        if (msg.sender != address(this)) {
            assembly {
                if tload(GUARD_SLOT) {
                    mstore(0, 0xb5dfd9e5) // ReentrancyGuard.Reentered.selector
                    revert(0x1c, 0x04)
                }
                tstore(GUARD_SLOT, 1)
            }
        }
        _;
        // Unlocks the guard, making the pattern composable.
        // After the function exits, it can be called again, even in the same transaction.
        if (msg.sender != address(this)) {
            assembly {
                tstore(GUARD_SLOT, 0)
            }
        }
    }
}
