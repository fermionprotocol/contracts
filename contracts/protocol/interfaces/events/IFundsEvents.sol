// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title IFundsEvents
 *
 * @notice Defines events related to funds management within the protocol.
 */
interface IFundsEvents {
    event AvailableFundsIncreased(uint256 indexed entityId, address indexed token, uint256 amount);
    event FundsWithdrawn(
        uint256 indexed entityId,
        address indexed withdrawnTo,
        address indexed tokenAddress,
        uint256 amount
    );
    event ERC721Deposited(address indexed tokenAddress, uint256 indexed tokenId, address indexed from);
    event ERC721Withdrawn(address indexed tokenAddress, uint256 indexed tokenId, address indexed withdrawnTo);
}
