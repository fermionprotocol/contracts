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
    event AuctionStarted(uint256 indexed tokenId, uint256 offeredFractions, uint256 targetPrice, uint256 auctionEnd);
    event BidPlaced(uint256 indexed tokenId, address indexed bidder, uint256 bidderId, uint256 amount);
    event AuctionFinished(uint256 indexed tokenId, address indexed winner, uint256 soldFractions, uint256 winningBid);
    event VaultAmountUpdated(uint256 indexed tokenId, uint256 amount);
}
