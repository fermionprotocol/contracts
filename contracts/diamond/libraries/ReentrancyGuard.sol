// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

/**
 * @title ReentrancyGuard
 *
 * @notice Prevent reeentrancy on a diamond level
 */
contract ReentrancyGuard {
    uint256 internal constant GUARD_SLOT = 0;
    error Reentrered();

    modifier nonReentrant() {
        assembly {
            if tload(GUARD_SLOT) {
                mstore(0, 0x6cee810b) // ReentrancyGuard.Reentrered.selector
                revert(0x1c, 0x04)
            }
            tstore(GUARD_SLOT, 1)
        }
        _;
        // Unlocks the guard, making the pattern composable.
        // After the function exits, it can be called again, even in the same transaction.
        assembly {
            tstore(GUARD_SLOT, 0)
        }
    }

    function removeGuard() internal {
        assembly {
            tstore(GUARD_SLOT, 0)
        }
    }
}
