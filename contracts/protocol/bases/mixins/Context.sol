// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ContextLib } from "../../libs/ContextLib.sol";

/**
 * @title Execution context
 *
 * @notice Provides the message sender
 */
contract Context {
    /**
     * @notice Returns the message sender address.
     *
     * @dev Could be msg.sender or the message sender address from storage (in case of meta transaction).
     *
     * @return the message sender address
     */
    function _msgSender() internal view virtual returns (address) {
        return ContextLib._msgSender();
    }
}
