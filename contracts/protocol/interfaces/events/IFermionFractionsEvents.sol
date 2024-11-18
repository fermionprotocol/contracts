// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IFermionFractionsEvents
 *
 * @notice Defines events related fractions and buyout auctions.
 */
interface IFermionFractionsEvents {
    event Bid(
        uint256 indexed tokenId,
        address indexed from,
        uint256 newPrice,
        uint256 fractionsCount,
        uint256 bidAmount
    );
    event Redeemed(uint256 indexed tokenId, address indexed from);
    event Claimed(address indexed from, uint256 fractionsBurned, uint256 amountClaimed);
    event Voted(uint256 indexed tokenId, address indexed from, uint256 fractionAmount);
    event VoteRemoved(uint256 indexed tokenId, address indexed from, uint256 fractionAmount);
    event AuctionStarted(uint256 indexed tokenId, uint256 endTime);
    event Fractionalised(uint256 indexed tokenId, uint256 fractionsCount);
    event FractionsSetup(uint256 initialFractionsAmount, FermionTypes.BuyoutAuctionParameters buyoutAuctionParameters);
    event AdditionalFractionsMinted(uint256 additionalAmount, uint256 totalFractionsAmount);
    // Buyout Exit Price Governance Update Events
    event PriceUpdateProposalCreated(
        uint256 indexed proposalId,
        uint256 newExitPrice,
        uint256 votingDeadline,
        uint256 quorumRequired
    );
    event PriceUpdateProposalFinalized(uint256 indexed proposalId, bool success);
    event PriceUpdateVoted(uint256 indexed proposalId, address indexed voter, uint256 voteCount, bool votedYes);
    event ExitPriceUpdated(uint256 newPrice, bool isOracleUpdate);
}
