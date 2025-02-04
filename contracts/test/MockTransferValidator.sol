// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockTransferValidator {
    bool private shouldRevert;

    error InvalidTransfer();

    function validateTransfer(address, address, address, uint256) external view {
        if (shouldRevert) {
            revert InvalidTransfer();
        }
    }

    function enableRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }
}
