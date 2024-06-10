// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title IFermionFractionsEvents
 *
 * @notice Defines events related fractions and buyout auctions.
 */
interface IFermionFractionsEvents {
    event Bid(address indexed from, uint256 newPrice, uint256 fractionsCount, uint256 bidAmount);
    event Redeemed(uint256 indexed tokenId, address indexed from);
    event Claimed(address indexed from, uint256 fractionsBurned, uint256 amountClaimed);
    event Voted(address indexed from, uint256 indexed tokenId, uint256 fractionAmount);
    event VoteRemoved(address indexed from, uint256 indexed tokenId, uint256 fractionAmount);
    event AuctionStarted(uint256 indexed tokenId, uint256 endTime);
}
