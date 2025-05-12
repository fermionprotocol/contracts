// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Common } from "./Common.sol";
import { FermionGeneralErrors, FractionalisationErrors, FermionErrors } from "../domain/Errors.sol";
import { HUNDRED_PERCENT, MIN_QUORUM_PERCENT, DEFAULT_GOV_VOTE_DURATION, MIN_GOV_VOTE_DURATION, MAX_GOV_VOTE_DURATION } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IPriceOracleRegistry } from "../interfaces/IPriceOracleRegistry.sol";
import { IFermionFNFTPriceManager } from "../interfaces/IFermionFNFTPriceManager.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC2771ContextUpgradeable as ERC2771Context } from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";

/**
 * @title FermionFNFTPriceManager
 * @dev This contract is an extension of the FermionFractions logic, specifically handling
 *      state-modifying functions related to buyout exit price updates (oracle and governance updates),
 *      and exit price overrides for individual tokens.
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
contract FermionFNFTPriceManager is FermionErrors, ERC2771Context, IFermionFNFTPriceManager {
    address internal immutable FERMION_PROTOCOL;

    constructor(address _fermionProtocol) ERC2771Context(_fermionProtocol) {
        if (_fermionProtocol == address(0)) revert FermionGeneralErrors.InvalidAddress();
        FERMION_PROTOCOL = _fermionProtocol;
    }

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
    function voteToStartAuction(
        uint256 _tokenId,
        uint256 _fractionAmount
    ) external returns (bool startAuctionInternal) {
        if (_fractionAmount == 0) revert InvalidAmount();
        uint256 currentEpoch = Common._getFermionFractionsStorage().currentEpoch;
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);
        FermionTypes.Auction storage auction = Common.getLastAuction(_tokenId, $);
        FermionTypes.AuctionDetails storage auctionDetails = auction.details;

        if (!$.tokenInfo[_tokenId].isFractionalised) revert TokenNotFractionalised(_tokenId);

        FermionTypes.AuctionState auctionState = auctionDetails.state;

        address msgSender = _msgSender();
        if (auctionDetails.maxBidder == msgSender) revert MaxBidderCannotVote(_tokenId);

        uint256 fractionsPerToken = auctionState >= FermionTypes.AuctionState.Ongoing
            ? auctionDetails.totalFractions
            : Common.liquidSupply(currentEpoch) / $.nftCount;

        FermionTypes.Votes storage votes = auction.votes;
        uint256 availableFractions = fractionsPerToken - votes.total - auctionDetails.lockedFractions;

        if (availableFractions == 0) revert NoFractionsAvailable(_tokenId);

        if (_fractionAmount > availableFractions) _fractionAmount = availableFractions;

        votes.individual[msgSender] += _fractionAmount;
        votes.total += _fractionAmount;

        if (auctionDetails.state == FermionTypes.AuctionState.NotStarted) {
            if (votes.total >= (fractionsPerToken * $.auctionParameters.unlockThreshold) / HUNDRED_PERCENT) {
                // NB: although in theory it's acceptable to start the auction without any bids, there could be
                // a racing situation where one user bids under the exit price, another user votes to start the auction and the first
                // user removes the bid. To avoid this, at least one bid must exist.
                if (auctionDetails.maxBid == 0) revert NoBids(_tokenId);

                startAuctionInternal = true;
            }
        }

        Common._transferFractions(msgSender, address(this), _fractionAmount, currentEpoch);

        emit IFermionFractionsEvents.Voted(_tokenId, msgSender, _fractionAmount);
    }

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
    function removeVoteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external {
        if (_fractionAmount == 0) revert InvalidAmount();

        FermionTypes.Auction storage auction = Common.getLastAuction(
            _tokenId,
            Common._getBuyoutAuctionStorage(Common._getFermionFractionsStorage().currentEpoch)
        );
        FermionTypes.AuctionDetails storage auctionDetails = auction.details;

        address msgSender = _msgSender();
        if (auctionDetails.maxBidder == msgSender) revert MaxBidderCannotVote(_tokenId);
        if (auctionDetails.state >= FermionTypes.AuctionState.Ongoing)
            revert AuctionOngoing(_tokenId, auctionDetails.timer);

        FermionTypes.Votes storage votes = auction.votes;
        if (_fractionAmount > votes.individual[msgSender]) {
            revert NotEnoughLockedVotes(_tokenId, _fractionAmount, votes.individual[msgSender]);
        }

        unchecked {
            votes.individual[msgSender] -= _fractionAmount;
            votes.total -= _fractionAmount;
        }

        Common._transferFractions(
            address(this),
            msgSender,
            _fractionAmount,
            Common._getFermionFractionsStorage().currentEpoch
        );

        emit IFermionFractionsEvents.VoteRemoved(_tokenId, msgSender, _fractionAmount);
    }

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
     * - `AlreadyVotedInProposal` if the caller has already voted in an active proposal.
     * - `OracleInternalError` if the oracle's `getPrice` reverts with an error different from `InvalidPrice`.
     *
     * @param _newPrice The proposed new exit price.
     * @param _quorumPercent The required quorum percentage for the governance proposal (in basis points).
     * @param _voteDuration The duration of the governance proposal in seconds.
     */
    function updateExitPrice(uint256 _newPrice, uint256 _quorumPercent, uint256 _voteDuration) external {
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(
            Common._getFermionFractionsStorage().currentEpoch
        );

        address oracle = $.priceOracle;
        if (oracle != address(0)) {
            if (_isOracleApproved(oracle)) {
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

        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        address erc20Clone = fractionStorage.epochToClone[fractionStorage.currentEpoch];
        uint256 proposerVotes = IERC20(erc20Clone).balanceOf(_msgSender());
        FermionTypes.PriceUpdateVoter memory voter = $.voters[_msgSender()];

        if (proposerVotes == 0) {
            revert FractionalisationErrors.OnlyFractionOwner();
        }
        if (
            $.priceUpdateProposals[voter.proposalId].state == FermionTypes.PriceUpdateProposalState.Active &&
            $.priceUpdateProposals[voter.proposalId].votingDeadline > block.timestamp
        ) {
            revert FractionalisationErrors.AlreadyVotedInProposal(voter.proposalId);
        }

        if (_quorumPercent < MIN_QUORUM_PERCENT || _quorumPercent > HUNDRED_PERCENT) {
            revert FermionGeneralErrors.InvalidPercentage(_quorumPercent);
        }

        if (_voteDuration == 0) {
            _voteDuration = DEFAULT_GOV_VOTE_DURATION;
        } else if (_voteDuration < MIN_GOV_VOTE_DURATION || _voteDuration > MAX_GOV_VOTE_DURATION) {
            revert FractionalisationErrors.InvalidVoteDuration(_voteDuration);
        }

        FermionTypes.PriceUpdateProposal memory newProposal;

        newProposal.proposalId = $.priceUpdateProposals.length;
        newProposal.newExitPrice = _newPrice;
        newProposal.votingDeadline = block.timestamp + _voteDuration;
        newProposal.quorumPercent = _quorumPercent;
        newProposal.yesVotes = proposerVotes;
        newProposal.state = FermionTypes.PriceUpdateProposalState.Active;

        $.priceUpdateProposals.push(newProposal);

        voter.proposalId = newProposal.proposalId;
        voter.votedYes = true;
        voter.voteCount = proposerVotes;

        $.voters[_msgSender()] = voter;

        emit IFermionFractionsEvents.PriceUpdateProposalCreated(
            newProposal.proposalId,
            _newPrice,
            newProposal.votingDeadline,
            _quorumPercent
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
     * @param _voteYes True to vote YES, false to vote NO.
     * @param _proposalId The ID of the proposal to vote on.
     */
    function voteOnProposal(bool _voteYes, uint256 _proposalId) external {
        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        uint256 currentEpoch = fractionStorage.currentEpoch;
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);
        FermionTypes.PriceUpdateProposal storage proposal = $.priceUpdateProposals[_proposalId];
        address msgSender = _msgSender();
        FermionTypes.PriceUpdateVoter memory voter = $.voters[msgSender];

        address erc20Clone = fractionStorage.epochToClone[currentEpoch];
        uint256 fractionsBalance = IERC20(erc20Clone).balanceOf(msgSender);

        if (
            proposal.state != FermionTypes.PriceUpdateProposalState.Active || proposal.votingDeadline < block.timestamp
        ) {
            revert FractionalisationErrors.ProposalNotActive(proposal.proposalId);
        }

        FermionTypes.PriceUpdateProposal storage voterProposal = $.priceUpdateProposals[voter.proposalId];
        if (voter.proposalId != proposal.proposalId) {
            if (
                voterProposal.state == FermionTypes.PriceUpdateProposalState.Active &&
                voterProposal.votingDeadline >= block.timestamp
            ) {
                revert FractionalisationErrors.AlreadyVotedInProposal(voter.proposalId);
            }
            voter.proposalId = proposal.proposalId;
            voter.votedYes = _voteYes;
            voter.voteCount = 0;
        }

        if (!_finalizeProposal(proposal, Common.liquidSupply(currentEpoch))) {
            if (fractionsBalance == 0) revert FractionalisationErrors.NoVotingPower(msgSender);
            uint256 additionalVotes;

            if (voter.votedYes != _voteYes) revert FractionalisationErrors.ConflictingVote();
            unchecked {
                additionalVotes = fractionsBalance > voter.voteCount ? fractionsBalance - voter.voteCount : 0;
            }
            if (additionalVotes == 0) revert FractionalisationErrors.AlreadyVoted();
            voter.voteCount = fractionsBalance;

            if (_voteYes) proposal.yesVotes += additionalVotes;
            else proposal.noVotes += additionalVotes;

            $.voters[msgSender] = voter;

            emit IFermionFractionsEvents.PriceUpdateVoted(proposal.proposalId, msgSender, fractionsBalance, _voteYes);
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
     *
     * @param _proposalId The ID of the proposal to remove the vote from.
     */
    function removeVoteOnProposal(uint256 _proposalId) external {
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(
            Common._getFermionFractionsStorage().currentEpoch
        );
        FermionTypes.PriceUpdateProposal storage proposal = $.priceUpdateProposals[_proposalId];
        address msgSender = _msgSender();

        if (
            proposal.state != FermionTypes.PriceUpdateProposalState.Active || proposal.votingDeadline < block.timestamp
        ) {
            revert FractionalisationErrors.ProposalNotActive(proposal.proposalId);
        }

        FermionTypes.PriceUpdateVoter storage voter = $.voters[msgSender];

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

        delete $.voters[msgSender];

        emit IFermionFractionsEvents.PriceUpdateVoteRemoved(proposal.proposalId, msgSender, votesToRemove, votedYes);
    }

    /**
     * @notice Finalizes the active proposal if the voting deadline has passed.
     *
     * Emits:
     * - PriceUpdateProposalFinalized (when the proposal is finalized)
     * - ExitPriceUpdated (if the proposal is executed successfully)
     *
     * @param _proposal The active price update proposal to finalize.
     * @param _liquidSupply The liquid supply of fractions, used to calculate the required quorum.
     * @return finalized True if the proposal was successfully finalized, otherwise false.
     */
    function _finalizeProposal(
        FermionTypes.PriceUpdateProposal storage _proposal,
        uint256 _liquidSupply
    ) internal returns (bool finalized) {
        if (block.timestamp <= _proposal.votingDeadline) {
            return false;
        }

        uint256 totalVotes = _proposal.yesVotes + _proposal.noVotes;
        uint256 quorumRequired = (_liquidSupply * _proposal.quorumPercent) / HUNDRED_PERCENT;

        if (totalVotes >= quorumRequired) {
            if (_proposal.yesVotes > _proposal.noVotes) {
                _proposal.state = FermionTypes.PriceUpdateProposalState.Executed;
                Common
                    ._getBuyoutAuctionStorage(Common._getFermionFractionsStorage().currentEpoch)
                    .auctionParameters
                    .exitPrice = _proposal.newExitPrice;
                emit IFermionFractionsEvents.ExitPriceUpdated(_proposal.newExitPrice, false);
            } else {
                _proposal.state = FermionTypes.PriceUpdateProposalState.Failed;
            }
        } else {
            _proposal.state = FermionTypes.PriceUpdateProposalState.Failed;
        }

        emit IFermionFractionsEvents.PriceUpdateProposalFinalized(
            _proposal.proposalId,
            _proposal.state == FermionTypes.PriceUpdateProposalState.Executed
        );

        return true;
    }
    /**
     * @notice Checks if the given oracle is approved in the oracle registry.
     *
     * @param _oracle The address of the price oracle to check.
     * @return isApproved True if the oracle is approved, otherwise false.
     */
    function _isOracleApproved(address _oracle) internal view returns (bool) {
        return IPriceOracleRegistry(FERMION_PROTOCOL).isPriceOracleApproved(_oracle);
    }

    /**
     * @notice Checks if the revert reason matches the custom error InvalidPrice().
     * @param _reason The revert reason.
     * @return isInvalidPrice True if the reason is InvalidPrice(), otherwise false.
     */
    function _isInvalidPriceError(bytes memory _reason) internal pure returns (bool) {
        return _reason.length == 4 && bytes4(_reason) == IPriceOracle.InvalidPrice.selector;
    }

    /**
     * @notice Adjusts the voter's records on transfer by removing votes if the remaining balance cannot support them.
     *         This ensures the proposal's vote count remains accurate.
     *
     * @dev If the voter has no active votes or the current proposal is not active, no adjustments are made.
     *      If the voter's remaining balance after the transfer is greater than or equal to their vote count,
     *      no votes are removed. If caller of the function is not the current epoch's ERC20 clone contract,
     *      no votes are adjusted.
     *
     * @param from The address of the sender whose votes may need adjustment.
     * @param amount The number of fractions being transferred.
     */
    function adjustVotesOnTransfer(address from, uint256 amount) external {
        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        uint256 currentEpoch = fractionStorage.currentEpoch;
        address currentERC20Clone = fractionStorage.epochToClone[currentEpoch];

        if (_msgSender() != currentERC20Clone) {
            return;
        }

        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);
        FermionTypes.PriceUpdateProposal storage proposal = $.priceUpdateProposals[$.voters[from].proposalId];

        if (
            proposal.state != FermionTypes.PriceUpdateProposalState.Active || proposal.votingDeadline < block.timestamp
        ) {
            return;
        }

        FermionTypes.PriceUpdateVoter storage voter = $.voters[from];
        uint256 voteCount = voter.voteCount;

        if (voteCount == 0 || voter.proposalId != proposal.proposalId) {
            return;
        }

        uint256 remainingBalance = IERC20(currentERC20Clone).balanceOf(from);

        if (remainingBalance >= voteCount) {
            return;
        }

        uint256 votesToRemove = voteCount - remainingBalance;
        voter.voteCount = remainingBalance;

        unchecked {
            if (voter.votedYes) {
                proposal.yesVotes -= votesToRemove;
            } else {
                proposal.noVotes -= votesToRemove;
            }
        }
        emit IFermionFractionsEvents.PriceUpdateVoteRemoved(proposal.proposalId, from, votesToRemove, voter.votedYes);
    }
}
