// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Common } from "./Common.sol";
import { FermionGeneralErrors, FractionalisationErrors } from "../domain/Errors.sol";
import { HUNDRED_PERCENT, MIN_QUORUM_PERCENT, DEFAULT_GOV_VOTE_DURATION, MIN_GOV_VOTE_DURATION, MAX_GOV_VOTE_DURATION } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IPriceOracleRegistry } from "../interfaces/IPriceOracleRegistry.sol";
import { IFermionFNFTPriceManager } from "../interfaces/IFermionFNFTPriceManager.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";
import { Context } from "../libs/Context.sol";

/**
 * @title FermionFNFTPriceManager
 * @dev This contract is an extension of the FermionFractions logic, specifically handling
 *      state-modifying functions related to buyout exit price updates (oracle and governance updates).
 *
 *      It works in conjunction with the FermionFractions contract, which hosts all
 *      getter functions for the associated data. The logic here manages the creation and
 *      finalization of price update proposals, oracle-based price updates, and voting mechanisms.
 * @notice - Getters for proposal and voter details are implemented in the main FermionFractions contract.
 *         - All state-modifying functions (e.g., price updates, voting) are implemented in this contract.
 *         - NOTE: This contract is expected to be called only by FermionFractions via `delegateCall`.
 *           Any direct call to its external methods will have no impact on the protocol state, as they
 *           rely on the context and storage of the calling contract.
 */
contract FermionFNFTPriceManager is Context, IFermionFNFTPriceManager {
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
     * @param _fermionProtocol Fermion diamond address containing the Oracle Registry Facet.
     * @param fractionsBalance The fractions balance of the caller.
     */
    function updateExitPrice(
        uint256 newPrice,
        uint256 quorumPercent,
        uint256 voteDuration,
        address _fermionProtocol,
        uint256 fractionsBalance
    ) external {
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage();
        FermionTypes.PriceUpdateProposal storage currentProposal = $.currentProposal;

        if (currentProposal.state == FermionTypes.PriceUpdateProposalState.Active) {
            revert FractionalisationErrors.OngoingProposalExists();
        }

        address oracle = $.priceOracle;
        if (oracle != address(0)) {
            if (_isOracleApproved(oracle, _fermionProtocol)) {
                try IPriceOracle(oracle).getPrice() returns (uint256 oraclePrice) {
                    $.auctionParameters.exitPrice = oraclePrice;
                    emit IFermionFractionsEvents.ExitPriceUpdated(oraclePrice, true);
                    return;
                } catch (bytes memory reason) {
                    if (!_isInvalidPriceError(reason)) {
                        revert FractionalisationErrors.OracleInternalError();
                    }
                }
            }
        }

        if (fractionsBalance == 0) {
            revert FractionalisationErrors.OnlyFractionOwner();
        }

        if (quorumPercent < MIN_QUORUM_PERCENT || quorumPercent > HUNDRED_PERCENT) {
            revert FermionGeneralErrors.InvalidPercentage(quorumPercent);
        }

        if (voteDuration == 0) {
            voteDuration = DEFAULT_GOV_VOTE_DURATION;
        } else if (voteDuration < MIN_GOV_VOTE_DURATION || voteDuration > MAX_GOV_VOTE_DURATION) {
            revert FractionalisationErrors.InvalidVoteDuration(voteDuration);
        }

        currentProposal.proposalId += 1;
        currentProposal.newExitPrice = newPrice;
        currentProposal.votingDeadline = block.timestamp + voteDuration;
        currentProposal.quorumPercent = quorumPercent;
        currentProposal.yesVotes = 0;
        currentProposal.noVotes = 0;
        currentProposal.state = FermionTypes.PriceUpdateProposalState.Active;

        emit IFermionFractionsEvents.PriceUpdateProposalCreated(
            currentProposal.proposalId,
            newPrice,
            currentProposal.votingDeadline,
            quorumPercent
        );
    }

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
    function voteOnProposal(bool voteYes, uint256 fractionsBalance, uint256 totalSupply) external {
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage();
        FermionTypes.PriceUpdateProposal storage proposal = $.currentProposal;
        uint256 liquidSupply = totalSupply -
            $.unrestricedRedeemableSupply -
            $.lockedRedeemableSupply -
            $.pendingRedeemableSupply;
        address msgSender = _msgSender();

        if (proposal.state != FermionTypes.PriceUpdateProposalState.Active) {
            revert FractionalisationErrors.ProposalNotActive(proposal.proposalId);
        }

        if (!_finalizeProposal(proposal, liquidSupply)) {
            if (fractionsBalance == 0) revert FractionalisationErrors.NoVotingPower(msgSender);

            FermionTypes.PriceUpdateVoter storage voter = proposal.voters[msgSender];
            uint256 additionalVotes;

            if (voter.proposalId == proposal.proposalId) {
                if (voter.votedYes != voteYes) revert FractionalisationErrors.ConflictingVote();
                unchecked {
                    additionalVotes = fractionsBalance > voter.voteCount ? fractionsBalance - voter.voteCount : 0;
                }
                if (additionalVotes == 0) revert FractionalisationErrors.AlreadyVoted();
            } else {
                voter.proposalId = proposal.proposalId;
                voter.votedYes = voteYes;
                additionalVotes = fractionsBalance;
            }
            voter.voteCount = fractionsBalance;

            if (voteYes) proposal.yesVotes += additionalVotes;
            else proposal.noVotes += additionalVotes;

            emit IFermionFractionsEvents.PriceUpdateVoted(proposal.proposalId, msgSender, fractionsBalance, voteYes);
        }
    }

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
    function removeVoteOnProposal() external {
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage();
        FermionTypes.PriceUpdateProposal storage proposal = $.currentProposal;
        address msgSender = _msgSender();

        if (proposal.state != FermionTypes.PriceUpdateProposalState.Active) {
            revert FractionalisationErrors.ProposalNotActive(proposal.proposalId);
        }

        FermionTypes.PriceUpdateVoter storage voter = proposal.voters[msgSender];

        if (voter.proposalId != proposal.proposalId) revert FractionalisationErrors.NoVotingPower(msgSender);

        uint256 votesToRemove = voter.voteCount;

        bool votedYes = voter.votedYes;
        unchecked {
            if (votedYes) {
                proposal.yesVotes -= votesToRemove;
            } else {
                proposal.noVotes -= votesToRemove;
            }
        }

        delete proposal.voters[msgSender];

        emit IFermionFractionsEvents.PriceUpdateVoteRemoved(proposal.proposalId, msgSender, votesToRemove, votedYes);
    }

    /**
     * @notice Finalizes the active proposal if the voting deadline has passed.
     *
     * Emits:
     * - PriceUpdateProposalFinalized (when the proposal is finalized)
     * - ExitPriceUpdated (if the proposal is executed successfully)
     *
     * @param proposal The active price update proposal to finalize.
     * @param liquidSupply The liquid supply of fractions, used to calculate the required quorum.
     * @return finalized True if the proposal was successfully finalized, otherwise false.
     */
    function _finalizeProposal(
        FermionTypes.PriceUpdateProposal storage proposal,
        uint256 liquidSupply
    ) internal returns (bool finalized) {
        if (block.timestamp <= proposal.votingDeadline) {
            return false;
        }

        uint256 totalVotes = proposal.yesVotes + proposal.noVotes;
        uint256 quorumRequired = (liquidSupply * proposal.quorumPercent) / HUNDRED_PERCENT;

        if (totalVotes >= quorumRequired) {
            if (proposal.yesVotes > proposal.noVotes) {
                proposal.state = FermionTypes.PriceUpdateProposalState.Executed;
                Common._getBuyoutAuctionStorage().auctionParameters.exitPrice = proposal.newExitPrice;
                emit IFermionFractionsEvents.ExitPriceUpdated(proposal.newExitPrice, false);
            } else {
                proposal.state = FermionTypes.PriceUpdateProposalState.Failed;
            }
        } else {
            proposal.state = FermionTypes.PriceUpdateProposalState.Failed;
        }

        emit IFermionFractionsEvents.PriceUpdateProposalFinalized(
            proposal.proposalId,
            proposal.state == FermionTypes.PriceUpdateProposalState.Executed
        );

        return true;
    }
    /**
     * @notice Checks if the given oracle is approved in the oracle registry.
     *
     * @param _oracle The address of the price oracle to check.
     * @param _fermionProtocol The address of the Fermion diamond.
     * @return isApproved True if the oracle is approved, otherwise false.
     */
    function _isOracleApproved(address _oracle, address _fermionProtocol) internal view returns (bool) {
        return IPriceOracleRegistry(_fermionProtocol).isPriceOracleApproved(_oracle);
    }

    /**
     * @notice Checks if the revert reason matches the custom error InvalidPrice().
     * @param _reason The revert reason.
     * @return isInvalidPrice True if the reason is InvalidPrice(), otherwise false.
     */
    function _isInvalidPriceError(bytes memory _reason) internal pure returns (bool) {
        return _reason.length == 4 && bytes4(_reason) == IPriceOracle.InvalidPrice.selector;
    }
}
