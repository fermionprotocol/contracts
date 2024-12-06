// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";

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
     * @param fermionProtocol Fermion diamond address containing the Oracle Registry Facet.
     * @param fractionsBalance The fractions balance of the caller.
     */
    function updateExitPrice(
        uint256 newPrice,
        uint256 quorumPercent,
        uint256 voteDuration,
        address fermionProtocol,
        uint256 fractionsBalance
    ) external;

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
     * @param voteYes True to vote YES, false to vote NO.
     * @param fractionsBalance The fractions balance of the voter.
     * @param totalSupply Total supply of fractions for quorum calculation.
     */
    function voteOnProposal(bool voteYes, uint256 fractionsBalance, uint256 totalSupply) external;

    /**
     * @notice Allows a voter to explicitly remove their vote on an active proposal.
     *
     * Emits:
     * - `PriceUpdateVoteRemoved` when a vote is successfully removed.
     *
     * Reverts:
     * - `ProposalNotActive` if the proposal is not active.
     * - `NoVotingPower` if the caller has no votes recorded on the active proposal.
     */
    function removeVoteOnProposal() external;
}
