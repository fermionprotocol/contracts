// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FermionStorage } from "./Storage.sol";

/*
 * @title Execution context
 *
 * @notice Provides the message sender
 */
library ContextLib {
    uint256 private constant ADDRESS_LENGTH = 20;

    /**
     * @notice Returns the message sender address.
     *
     * @dev Could be msg.sender or the message sender address from storage (in case of meta transaction).
     *
     * @return the message sender address
     */
    function _msgSender() internal view returns (address) {
        uint256 msgDataLength = msg.data.length;
        address protocolAddress = FermionStorage.metaTransaction().fermionAddress;

        // Get sender from the storage if this is a meta transaction
        if (msg.sender == protocolAddress && msgDataLength >= ADDRESS_LENGTH) {
            unchecked {
                return address(bytes20(msg.data[msgDataLength - ADDRESS_LENGTH:]));
            }
        } else {
            return msg.sender;
        }
    }
}
