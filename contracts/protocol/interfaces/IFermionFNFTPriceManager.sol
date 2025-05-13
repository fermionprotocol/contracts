// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

interface IFermionFNFTPriceManager {
    /**
     * @notice Updates the exit price using either an oracle or a governance proposal.
     *
     * Emits:
     * - `ExitPriceUpdated` if the exit price is updated via the oracle.
     * - `PriceUpdateProposalCreated` if a governance proposal is created.
     *
     * Reverts:
     * - `OnlyFractionOwner` if the caller is not a fraction owner.
     * - `InvalidQuorumPercent` if the `quorumPercent` is outside the allowed range.
     * - `InvalidVoteDuration` if the `voteDuration` is outside the allowed range.
     * - `OngoingProposalExists` if there is an active proposal.
     * - `OracleInternalError` if the oracle's `getPrice` reverts with an error different from `InvalidPrice`.
     *
     * @param newPrice The proposed new exit price.
     * @param quorumPercent The required quorum percentage for the governance proposal (in basis points).
     * @param voteDuration The duration of the governance proposal in seconds.
     */
    function updateExitPrice(uint256 newPrice, uint256 quorumPercent, uint256 voteDuration) external;

    /**
     * @notice Allows a fraction owner to vote on the current active proposal.
     *
     * Emits:
     * - `PriceUpdateVoted` when a fraction owner casts or updates their vote.
     *
     * Reverts:
     * - `ProposalNotActive` if the proposal is not active.
     * - `NoVotingPower` if the caller has no fractions to vote with.
     * - `ConflictingVote` if the caller attempts to vote differently from their previous vote.
     * - `AlreadyVoted` if the caller has already voted and has no additional fractions to contribute.
     *
     * @param _proposalId The ID of the proposal to vote on.
     * @param voteYes True to vote YES, false to vote NO.
     */
    function voteOnProposal(uint256 _proposalId, bool voteYes) external;

    /**
     * @notice Allows a voter to explicitly remove their vote on an active proposal.
     *
     * Emits:
     * - `PriceUpdateVoteRemoved` when a vote is successfully removed.
     *
     * Reverts:
     * - `ProposalNotActive` if the proposal is not active.
     * - `NoVotingPower` if the caller has no votes recorded on the active proposal.
     *
     * @param _proposalId The ID of the proposal to remove the vote from.
     */
    function removeVoteOnProposal(uint256 _proposalId) external;

    /**
     * @notice Fractional owners can vote to start the auction for a specific token, even if the current bid is below the exit price.
     * They need to lock their fractions to vote. The fractions can be unlocked before the auction starts.
     * The fractions can be used to bid in the auction.
     * The locked votes guarantee to get the proceeds from the auction for the specific token.
     * It's possible to vote even if the auction is ongoing and lock the auction proceeds this way.
     * The auction is started when the total number of locked fractions reaches the unlock threshold.
     *
     * Emits a Voted event if successful.
     * Emits an AuctionStarted event if the auction is started.
     *
     * Reverts if:
     * - The caller is the current max bidder
     * - The number of fractions to vote is zero
     * - The caller does not have enough fractions to vote
     * - The token is not fractionalised
     * - All available fractions are already locked (either by vote or by the current winning bidder)
     * - The cumulative total votes is enough to start the auction but there is no active bid
     *
     * @param _tokenId The token Id
     * @param _fractionAmount The number of tokens to use to vote
     */
    function voteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external returns (bool startAuctionInternal);

    /**
     * @notice Remove the vote to start the auction for a specific token. See `voteToStartAuction` for more details.
     *
     * Reverts if:
     * - The number of fractions to vote is zero
     * - The caller is the current max bidder
     * - The auction is already ongoing
     * - The caller tries to unlock more fractions than they have voted
     *
     * @param _tokenId The token Id
     * @param _fractionAmount The number of tokens to use to vote
     */
    function removeVoteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external;

    /**
     * @notice Adjusts the voter's records on transfer by removing votes if the remaining balance cannot support them.
     *         This ensures the proposal's vote count remains accurate.
     *
     * @dev If the voter has no active votes or the current proposal is not active, no adjustments are made.
     *      If the voter's remaining balance after the transfer is greater than or equal to their vote count,
     *      no votes are removed.If caller of the function is not the current epoch's ERC20 clone contract,
     *      no votes are adjusted.
     *
     *
     * @param from The address of the sender whose votes may need adjustment.
     * @param amount The number of fractions being transferred.
     */
    function adjustVotesOnTransfer(address from, uint256 amount) external;
}
