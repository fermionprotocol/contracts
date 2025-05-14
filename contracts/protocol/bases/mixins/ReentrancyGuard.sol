// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

/**
 * @title ReentrancyGuard
 *
 * @notice Prevent reeentrancy on a facet function level
 */
contract ReentrancyGuard {
    uint256 internal constant GUARD_SLOT = 0;
    uint256 internal constant GUARD_LOCKED = 1;
    uint256 internal constant GUARD_UNLOCKED = 0;
    uint256 internal constant REVERT_DATA_OFFSET = 0x1c;
    uint256 internal constant REVERT_DATA_SIZE = 0x04;
    bytes4 internal constant REENTRANCY_ERROR_SELECTOR = 0xb5dfd9e5;

    error Reentered();

    modifier nonReentrant() {
        // NB: it's more optiomal to compare msg.sender to address(this) twice than storing it in a variable (e.g. _isSelf)
        // - it's cheaper
        // - it does not add a variable to the stack and cause stack too deep errors
        if (msg.sender != address(this)) {
            assembly {
                if tload(GUARD_SLOT) {
                    mstore(0, REENTRANCY_ERROR_SELECTOR)
                    revert(REVERT_DATA_OFFSET, REVERT_DATA_SIZE)
                }
                tstore(GUARD_SLOT, GUARD_LOCKED)
            }
        }
        _;
        // Unlocks the guard, making the pattern composable.
        // After the function exits, it can be called again, even in the same transaction.
        if (msg.sender != address(this)) {
            assembly {
                tstore(GUARD_SLOT, GUARD_UNLOCKED)
            }
        }
    }
}
