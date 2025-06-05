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
        uint256 bidAmount,
        uint256 epoch
    );
    event Redeemed(uint256 indexed tokenId, address indexed from, uint256 epoch);
    event Claimed(address indexed from, uint256 fractionsBurned, uint256 amountClaimed, uint256 epoch);
    event Voted(uint256 indexed tokenId, address indexed from, uint256 fractionAmount, uint256 epoch);
    event VoteRemoved(uint256 indexed tokenId, address indexed from, uint256 fractionAmount, uint256 epoch);
    event AuctionStarted(uint256 indexed tokenId, uint256 endTime, uint256 epoch);
    event Fractionalised(uint256 indexed tokenId, uint256 fractionsCount, uint256 epoch);
    event FractionsSetup(
        uint256 initialFractionsAmount,
        FermionTypes.BuyoutAuctionParameters buyoutAuctionParameters,
        uint256 epoch
    );
    event AdditionalFractionsMinted(uint256 additionalAmount, uint256 totalFractionsAmount, uint256 epoch);
    // Buyout Exit Price Governance Update Events
    event PriceUpdateProposalCreated(
        uint256 indexed proposalId,
        uint256 newExitPrice,
        uint256 votingDeadline,
        uint256 quorumRequired,
        uint256 epoch
    );
    event PriceUpdateProposalFinalized(uint256 indexed proposalId, bool success, uint256 epoch);
    event PriceUpdateVoted(
        uint256 indexed proposalId,
        address indexed voter,
        uint256 voteCount,
        bool votedYes,
        uint256 epoch
    );
    event PriceUpdateVoteRemoved(
        uint256 indexed proposalId,
        address indexed voter,
        uint256 votesRemoved,
        bool votedYes,
        uint256 epoch
    );
    event ExitPriceUpdated(uint256 newPrice, bool isOracleUpdate, uint256 epoch);
    event FractionsMigrated(address owners, uint256 fractionBalance);
}
