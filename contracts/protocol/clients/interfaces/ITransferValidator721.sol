// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;
interface ITransferValidator721 {
    /// @notice Ensure that a transfer has been authorized for a specific tokenId
    function validateTransfer(address caller, address from, address to, uint256 tokenId) external view;
}
