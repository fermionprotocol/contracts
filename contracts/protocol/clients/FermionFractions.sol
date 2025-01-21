// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HUNDRED_PERCENT } from "../domain/Constants.sol";
import { FermionErrors, FermionGeneralErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionFractionsERC20Base } from "./FermionFractionsERC20Base.sol";
import { Common } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { IFermionFNFTPriceManager } from "../interfaces/IFermionFNFTPriceManager.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { FermionFractionsMint } from "./FermionFractionsMint.sol";
import { FermionBuyoutAuction } from "./FermionBuyoutAuction.sol";

/**
 * @dev Fractionalisation and buyout auction
 */
abstract contract FermionFractions is
    FermionFractionsERC20Base,
    FermionFNFTBase,
    FermionErrors,
    FundsLib,
    IFermionFractionsEvents,
    IFermionFractions
{
    using Address for address;

    address private immutable FNFT_FRACTION_MINT;
    address private immutable FNFT_PRICE_MANAGER;
    address private immutable FNFT_BUYOUT_AUCTION;

    /**
     * @notice Constructor
     *
     * @param _fnftPriceManager The address of FNFT price manager holding buyout auction exit price update
     * @param _fnftBuyoutAuction The address of the buyout auction contract
     */
    constructor(address _fnftFractionMint, address _fnftPriceManager, address _fnftBuyoutAuction) {
        if (_fnftPriceManager == address(0)) revert FermionGeneralErrors.InvalidAddress();
        FNFT_FRACTION_MINT = _fnftFractionMint;
        FNFT_PRICE_MANAGER = _fnftPriceManager;
        FNFT_BUYOUT_AUCTION = _fnftBuyoutAuction;
    }
    /**
     * @notice Initializes the contract
     *
     * @param _exchangeToken The address of the exchange token
     */
    function intializeFractions(address _exchangeToken) internal virtual {
        Common._getBuyoutAuctionStorage().exchangeToken = _exchangeToken;
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions. Sets the auction parameters and custodian vault parameters.
     * This function is called when the first NFT is fractionalised.
     * If some NFTs are already fractionalised, use `mintFractions(uint256 _firstTokenId, uint256 _length)` instead.
     *
     * Emits FractionsSetup and Fractionalised events if successful.
     *
     * Reverts if:
     * - Number of tokens to fractionalise is zero
     * - Other tokens are fractionalised already
     * - Exit price is zero
     * - Fractions amount is not in the range [MIN_FRACTIONS, MAX_FRACTIONS]
     * - Token state is not Verified
     * - Token has been fractionalised already
     * - Caller is neither approved to transfer the NFTs nor is the fermion protocol
     * - The oracle is not whitelisted in the oracle registry.
     *
     * @param _firstTokenId The starting token ID
     * @param _length The number of tokens to fractionalise
     * @param _fractionsAmount The number of fractions to mint for each NFT
     * @param _buyoutAuctionParameters The buyout auction parameters
     * @param _custodianVaultParameters The custodian vault parameters
     * @param _depositAmount The amount to deposit
     * @param _priceOracle The address of the price oracle.
     */
    function mintFractions(
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _fractionsAmount,
        FermionTypes.BuyoutAuctionParameters memory _buyoutAuctionParameters,
        FermionTypes.CustodianVaultParameters calldata _custodianVaultParameters,
        uint256 _depositAmount,
        address _priceOracle
    ) external {
        // todo just pass calldata
        FNFT_FRACTION_MINT.functionDelegateCall(
            abi.encodeCall(
                FermionFractionsMint.mintFractionsAndSetupParameters,
                (
                    _firstTokenId,
                    _length,
                    _fractionsAmount,
                    _buyoutAuctionParameters,
                    _custodianVaultParameters,
                    _depositAmount,
                    _priceOracle
                )
            )
        );
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions. The number of fractions matches the number of fractions for existing NFTs.
     * This function is called when additional NFTs are fractionalised.
     *
     * Reverts if:
     * - Number of tokens to fractionalise is zero
     * - No tokens are fractionalised already
     * - Token state is not Verified
     * - Token has been fractionalised already
     * - Caller is neither approved to transfer the NFTs nor is the fermion protocol
     *
     * @param _firstTokenId The starting token ID
     * @param _length The number of tokens to fractionalise
     * @param _depositAmount - the amount to deposit
     */
    function mintFractions(uint256 _firstTokenId, uint256 _length, uint256 _depositAmount) external {
        FNFT_FRACTION_MINT.functionDelegateCall(
            abi.encodeCall(FermionFractionsMint.mintFractions, (_firstTokenId, _length, _depositAmount))
        );
    }

    /**
     * @notice Mints additional fractions to be sold in the partial auction to fill the custodian vault.
     *
     * Emits AdditionalFractionsMinted event if successful.
     *
     * Reverts if:
     * - The caller is not the fermion protocol
     *
     * N.B. The protocol is trusted to mint the correct number of fractions
     *
     * @param _amount The number of fractions to mint
     */
    function mintAdditionalFractions(uint256 _amount) external {
        FNFT_FRACTION_MINT.functionDelegateCall(
            abi.encodeCall(FermionFractionsMint.mintAdditionalFractions, (_amount))
        );
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
    function voteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external {
        bytes memory _startAuctionInternal = FNFT_PRICE_MANAGER.functionDelegateCall(
            abi.encodeCall(IFermionFNFTPriceManager.voteToStartAuction, (_tokenId, _fractionAmount))
        );

        if (abi.decode(_startAuctionInternal, (bool))) {
            FNFT_BUYOUT_AUCTION.functionDelegateCall(
                abi.encodeCall(FermionBuyoutAuction.startAuctionInternal, (_tokenId))
            );
        }
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
        FNFT_PRICE_MANAGER.functionDelegateCall(
            abi.encodeCall(IFermionFNFTPriceManager.removeVoteToStartAuction, (_tokenId, _fractionAmount))
        );
    }

    /**
     * @notice Starts the auction for a specific fractionalized token. Can be called by anyone.
     *
     * Emits:
     * - `AuctionStarted` event indicating the start of the auction.
     *
     * Reverts:
     * - `TokenNotFractionalised` if the specified token has not been fractionalized.
     * - `AuctionOngoing` if the auction is already ongoing or has transitioned to a state other than `NotStarted`.
     * - `BidBelowExitPrice` if the highest bid is below the required exit price set for the auction.
     *
     * @param _tokenId The ID of the fractionalized token for which the auction is being started.
     */
    function startAuction(uint256 _tokenId) external {
        FNFT_BUYOUT_AUCTION.functionDelegateCall(abi.encodeCall(FermionBuyoutAuction.startAuction, (_tokenId)));
    }

    /**
     * @notice Participate in the auction for a specific token.
     *
     * Emits a Bid event if successful.
     *
     * Reverts if:
     * - The price is less than a minimal increment above the existing bid
     * - The auction has ended
     * - The caller does not pay the price
     *
     * @param _tokenId The token Id
     * @param _price The bidding price
     * @param _fractions The number of fractions to use for the bid, in addition to the fractions already locked during the votes
     */
    function bid(uint256 _tokenId, uint256 _price, uint256 _fractions) external payable {
        FNFT_BUYOUT_AUCTION.functionDelegateCall(
            abi.encodeCall(FermionBuyoutAuction.bid, (_tokenId, _price, _fractions))
        );
    }

    /**
     * @notice Remove a bid from the auction. This is possible only if the auction has not started yet.
     *
     * Emits a Bid event with zero arguments if successful.
     *
     * Reverts if:
     * - The auction has started
     * - The auction has not started yet, but the bid locktime has not passed yet
     * - The caller is not the max bidder
     *
     * @param _tokenId The token Id
     */
    function removeBid(uint256 _tokenId) external {
        FNFT_BUYOUT_AUCTION.functionDelegateCall(abi.encodeCall(FermionBuyoutAuction.removeBid, (_tokenId)));
    }

    /**
     * @notice Claim the F-NFT after the auction has ended.
     *
     * Emits a Redeemed event if successful.
     *
     * Reverts if:
     * - The auction has not started yet or is still ongoing
     * - The caller is not the max bidder
     *
     * @param _tokenId The token Id
     */
    function redeem(uint256 _tokenId) external {
        FNFT_BUYOUT_AUCTION.functionDelegateCall(abi.encodeCall(FermionBuyoutAuction.redeem, (_tokenId)));
    }

    /**
     * @notice Claim the specific auction proceeds if the user has voted to start the auction.
     *
     * Emits a Claimed event if successful.
     *
     * Reverts if:
     * - The auction has not started yet or is still ongoing
     * - The caller has no fractions locked
     * - The caller has no less fractions locked than the amount to claim
     *
     * @param _tokenId The token Id
     * @param _auctionIndex The auction index (if multiple auctions for the same F-NFT took place)
     * @param _additionalFractions Number of fractions to exchange for auction proceeds (in addition to the locked fractions)
     */
    function claimWithLockedFractions(uint256 _tokenId, uint256 _auctionIndex, uint256 _additionalFractions) external {
        FNFT_BUYOUT_AUCTION.functionDelegateCall(
            abi.encodeCall(
                FermionBuyoutAuction.claimWithLockedFractions,
                (_tokenId, _auctionIndex, _additionalFractions)
            )
        );
    }

    /**
     * @notice Claim the auction proceeds of all finalized auctions.
     * This withdraws only the proceeds of already finalized auctions.
     * To finalize an auction, one must call either `redeem`, `finalizeAndClaim` or `claimWithLockedFractions`.
     *
     * Emits a Claimed event if successful.
     *
     * Reverts if:
     * - The amount to claim is zero
     * - The caller has less fractions available than the amount to claim
     *
     * @param _fractions Number of fractions to exchange for auction proceeds
     */
    function claim(uint256 _fractions) public {
        FNFT_BUYOUT_AUCTION.functionDelegateCall(abi.encodeCall(FermionBuyoutAuction.claim, (_fractions)));
    }

    /**
     * @notice Finalize the auction for tokenId and claim the auction proceeds of all finalized auctions.
     * Use this if some auction ended, but was not finalized yet.
     *
     * Emits a Claimed event if successful.
     *
     * Reverts if:
     * - The amount to claim is zero
     * - The caller has less fractions available than the amount to claim
     *
     * @param _fractions Number of fractions to exchange for auction proceeds
     */
    function finalizeAndClaim(uint256 _tokenId, uint256 _fractions) external {
        FNFT_BUYOUT_AUCTION.functionDelegateCall(
            abi.encodeCall(FermionBuyoutAuction.finalizeAndClaim, (_tokenId, _fractions))
        );
    }

    /**
     * @notice Updates the exit price using either an oracle or a governance proposal.
     *         If the oracle provides a valid price, it is updated directly; otherwise,
     *         a governance proposal is created.
     *
     * @dev If an oracle is set, the price is fetched and used if valid. Anyone can update
     *      the price if oracle has bee configured.
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
     * - `PriceOracleNotWhitelisted` if the oracle is not whitelisted in the registry.
     *
     * @param _newPrice The proposed new exit price.
     * @param _quorumPercent The required quorum percentage for the governance proposal (in basis points).
     * @param _voteDuration The duration of the governance proposal in seconds.
     */
    function updateExitPrice(uint256 _newPrice, uint256 _quorumPercent, uint256 _voteDuration) external {
        FNFT_PRICE_MANAGER.functionDelegateCall(
            abi.encodeCall(
                IFermionFNFTPriceManager.updateExitPrice,
                (_newPrice, _quorumPercent, _voteDuration, fermionProtocol, balanceOf(_msgSender()))
            )
        );
    }
    /**
     * @notice Allows a fraction owner to vote on the current active proposal.
     *         If the caller has acquired additional fractions, the vote will be updated
     *         to include the newly acquired fractions.
     *
     * @dev The caller must vote with all fractions they own at the time of calling.
     *      If the caller has already voted, the vote must match the previous choice
     *      (YES or NO). Additional votes are automatically added to the previous choice.
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
     */
    function voteOnProposal(bool _voteYes) external {
        FNFT_PRICE_MANAGER.functionDelegateCall(
            abi.encodeCall(
                IFermionFNFTPriceManager.voteOnProposal,
                (_voteYes, FermionFractionsERC20Base.balanceOf(_msgSender()))
            )
        );
    }

    /**
     * @notice Allows a voter to explicitly remove their vote on an active proposal.
     *
     * @dev removes the complete vote count for the msg.sender
     *
     * Emits:
     * - `PriceUpdateVoteRemoved` when a vote is successfully removed.
     *
     * Reverts:
     * - `ProposalNotActive` if the proposal is not active.
     * - `NoVotingPower` if the caller has no votes recorded on the active proposal.
     *
     */
    function removeVoteOnProposal() external {
        FNFT_PRICE_MANAGER.functionDelegateCall(abi.encodeCall(IFermionFNFTPriceManager.removeVoteOnProposal, ()));
    }

    /**
     * @notice Returns the number of fractions. Represents the ERC20 balanceOf method
     *
     * @param _owner The address to check
     */
    function balanceOf(
        address _owner
    ) public view virtual override(ERC721, FermionFractionsERC20Base) returns (uint256) {
        return FermionFractionsERC20Base.balanceOf(_owner);
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `value`.
     */
    function transfer(
        address to,
        uint256 value
    ) public virtual override(FermionFractionsERC20Base, IFermionFractions) returns (bool) {
        return FermionFractionsERC20Base.transfer(to, value);
    }

    /**
     * @notice Returns the buyout auction parameters
     */
    function getBuyoutAuctionParameters() external view returns (FermionTypes.BuyoutAuctionParameters memory) {
        return Common._getBuyoutAuctionStorage().auctionParameters;
    }

    /**
     * @notice Returns the auction details
     *
     * @param _tokenId The token Id
     * @return auction The auction details
     */
    function getAuctionDetails(uint256 _tokenId) external view returns (FermionTypes.AuctionDetails memory) {
        return Common.getLastAuction(_tokenId, Common._getBuyoutAuctionStorage()).details;
    }

    /**
     * @notice Returns the auction details for past auctions
     *
     * @param _tokenId The token Id
     * @param _auctionIndex The auction index (if there are multiple auctions for the same F-NFT)
     * @return auction The auction details
     */
    function getPastAuctionDetails(
        uint256 _tokenId,
        uint256 _auctionIndex
    ) external view returns (FermionTypes.AuctionDetails memory) {
        FermionTypes.Auction[] storage auctionList = Common._getBuyoutAuctionStorage().tokenInfo[_tokenId].auctions;
        uint256 numberOfAuctions = auctionList.length; // it can be greater than one if the item was fractionalized multiple times
        if (_auctionIndex >= numberOfAuctions) {
            revert InvalidAuctionIndex(_auctionIndex, numberOfAuctions);
        }

        return auctionList[_auctionIndex].details;
    }

    /**
     * @notice Returns the votes for a specific token
     *
     * @param _tokenId The token Id
     * @return totalVotes The total number of votes
     * @return threshold The threshold to start the auction
     * @return availableFractions The number of fractions available to vote
     */
    function getVotes(
        uint256 _tokenId
    ) external view returns (uint256 totalVotes, uint256 threshold, uint256 availableFractions) {
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage();
        FermionTypes.Auction storage auction = Common.getLastAuction(_tokenId, $);

        uint256 fractionsPerToken = auction.details.totalFractions;
        if (fractionsPerToken == 0) fractionsPerToken = liquidSupply() / $.nftCount;

        FermionTypes.Votes storage votes = auction.votes;
        totalVotes = votes.total;
        availableFractions = fractionsPerToken - totalVotes;
        threshold = (fractionsPerToken * $.auctionParameters.unlockThreshold) / HUNDRED_PERCENT;
    }

    /**
     * @notice Returns the locked votes for a specific token
     *
     * @param _tokenId The token Id
     * @return lockedVotes The locked votes
     */
    function getIndividualLockedVotes(uint256 _tokenId, address _voter) external view returns (uint256 lockedVotes) {
        return Common.getLastAuction(_tokenId, Common._getBuyoutAuctionStorage()).votes.individual[_voter];
    }

    /**
     * @notice Returns the non-mapping details of the current active proposal.
     *
     * @return proposalId The unique ID of the proposal.
     * @return newExitPrice The proposed exit price.
     * @return votingDeadline The deadline for voting.
     * @return quorumPercent The required quorum percentage.
     * @return yesVotes The number of votes in favor.
     * @return noVotes The number of votes against.
     * @return state The state of the proposal (Active, Executed, or Failed).
     */
    function getCurrentProposalDetails()
        external
        view
        returns (
            uint256 proposalId,
            uint256 newExitPrice,
            uint256 votingDeadline,
            uint256 quorumPercent,
            uint256 yesVotes,
            uint256 noVotes,
            FermionTypes.PriceUpdateProposalState state
        )
    {
        FermionTypes.PriceUpdateProposal storage proposal = Common._getBuyoutAuctionStorage().currentProposal;
        return (
            proposal.proposalId,
            proposal.newExitPrice,
            proposal.votingDeadline,
            proposal.quorumPercent,
            proposal.yesVotes,
            proposal.noVotes,
            proposal.state
        );
    }

    /**
     * @notice Returns the vote details for a specific voter in the current proposal.
     *
     * @param _voter The address of the voter.
     * @return voterDetails The details of the voter's vote.
     */
    function getVoterDetails(address _voter) external view returns (FermionTypes.PriceUpdateVoter memory voterDetails) {
        voterDetails = Common._getBuyoutAuctionStorage().currentProposal.voters[_voter];
    }
}
