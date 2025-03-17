// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HUNDRED_PERCENT } from "../domain/Constants.sol";
import { FermionErrors, FermionGeneralErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Common } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FundsManager } from "../bases/mixins/FundsManager.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { IFermionFNFTPriceManager } from "../interfaces/IFermionFNFTPriceManager.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { FermionBuyoutAuction } from "./FermionBuyoutAuction.sol";
import { FermionFractionsERC20 } from "./FermionFractionsERC20.sol";

/**
 * @dev Fractionalisation and buyout auction
 */
abstract contract FermionFractions is
    FermionFNFTBase,
    FermionErrors,
    FundsManager,
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
        Common._getBuyoutAuctionStorage(0).exchangeToken = _exchangeToken;
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
        forwardCall(FNFT_FRACTION_MINT);
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
        forwardCall(FNFT_FRACTION_MINT);
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
        forwardCall(FNFT_FRACTION_MINT);
    }

    /**
     * @notice Migrates the fractions to the new ERC20 clone for the current epoch.
     * This function can be used only if the FermionFNFT was deployed in v1.0.1 or earlier.
     * Using this function on a contract deployed in v1.0.2 or later will revert since ERC20 balances are zero.
     *
     * Emits FractionsMigrated event if successful.
     *
     * Reverts if:
     * - Number of owners is zero
     * - Owner has no fractions
     * - Owner has already migrated
     *
     * @param _owners The array of owners to migrate the fractions for
     */
    function migrateFractions(address[] calldata _owners) external {
        forwardCall(FNFT_FRACTION_MINT);
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
        bytes memory _startAuctionInternal = forwardCall(FNFT_PRICE_MANAGER);

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
        forwardCall(FNFT_PRICE_MANAGER);
    }

    /**
     * @notice Adjusts the voter's records on transfer by removing votes if the remaining balance cannot support them.
     *         This ensures the proposal's vote count remains accurate when fractions are transferred.
     *
     * @dev This function is called by the FermionFractionsERC20 contract after a transfer occurs.
     *      If the voter has no active votes or the current proposal is not active, no adjustments are made.
     *      If caller of the function is not the current epoch's ERC20 clone contract, no votes are adjusted.
     *
     * @param from The address of the sender whose votes may need adjustment.
     * @param amount The number of fractions being transferred.
     */
    function adjustVotesOnTransfer(address from, uint256 amount) external {
        forwardCall(FNFT_PRICE_MANAGER);
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
        forwardCall(FNFT_BUYOUT_AUCTION);
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
        forwardCall(FNFT_BUYOUT_AUCTION);
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
        forwardCall(FNFT_BUYOUT_AUCTION);
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
        forwardCall(FNFT_BUYOUT_AUCTION);
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
        forwardCall(FNFT_BUYOUT_AUCTION);
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
        forwardCall(FNFT_BUYOUT_AUCTION);
    }

    /**
     * @notice Claim the auction proceeds of all finalized auctions from a specific epoch.
     * This withdraws only the proceeds of already finalized auctions for a specific epoch.
     * To finalize an auction, one must call either `redeem`, `finalizeAndClaim` or `claimWithLockedFractions`.
     *
     * Emits a ClaimedFromEpoch event if successful.
     *
     * Reverts if:
     * - The amount to claim is zero
     * - The caller has less fractions available than the amount to claim
     *
     * @param _fractions Number of fractions to exchange for auction proceeds
     * @param _epoch The epoch to claim from
     */
    function claimFromEpoch(uint256 _fractions, uint256 _epoch) public {
        forwardCall(FNFT_BUYOUT_AUCTION);
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
     * @param _tokenId The token Id
     * @param _fractions Number of fractions to exchange for auction proceeds
     */
    function finalizeAndClaim(uint256 _tokenId, uint256 _fractions) external {
        forwardCall(FNFT_BUYOUT_AUCTION);
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
                (_newPrice, _quorumPercent, _voteDuration, fermionProtocol)
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
        forwardCall(FNFT_PRICE_MANAGER);
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
        forwardCall(FNFT_PRICE_MANAGER);
    }

    /**
     * @notice Returns the address of the ERC20 clone for a specific epoch
     * Users should interact with this contract directly for ERC20 operations
     *
     * @param _epoch The epoch
     * @return The address of the ERC20 clone
     */
    function getERC20CloneAddress(uint256 _epoch) public view returns (address) {
        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        if (_epoch >= fractionStorage.epochToClone.length) {
            return address(0);
        }
        address cloneAddress = fractionStorage.epochToClone[_epoch];
        return cloneAddress;
    }

    /**
     * @notice Returns the buyout auction parameters for an arbitrary epoch
     */
    function getBuyoutAuctionParameters(
        uint256 _epoch
    ) external view returns (FermionTypes.BuyoutAuctionParameters memory) {
        return Common._getBuyoutAuctionStorage(_epoch).auctionParameters;
    }

    /**
     * @notice Returns the latest auction details for current epoch
     *
     * @param _tokenId The token Id
     * @return auction The auction details
     */
    function getAuctionDetails(uint256 _tokenId) external view returns (FermionTypes.AuctionDetails memory) {
        return
            Common
                .getLastAuction(
                    _tokenId,
                    Common._getBuyoutAuctionStorage(Common._getFermionFractionsStorage().currentEpoch)
                )
                .details;
    }

    /**
     * @notice Returns the current epoch
     */
    function getCurrentEpoch() external view returns (uint256) {
        return Common._getFermionFractionsStorage().currentEpoch;
    }

    /**
     * @notice Returns the total number of fractions for a specific epoch
     */
    function totalSupply(uint256 _epoch) public view returns (uint256) {
        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        if (_epoch >= fractionStorage.epochToClone.length) {
            return 0;
        }
        address erc20Clone = fractionStorage.epochToClone[_epoch];

        return FermionFractionsERC20(erc20Clone).totalSupply();
    }

    /**
     * @notice Returns the auction details for past auctions
     * @dev with each new epoch the auction index is reset to 0
     * @param _tokenId The token Id
     * @param _auctionIndex The auction index (if there are multiple auctions for the same F-NFT)
     * @param _epoch The epoch in which the auction took place
     * @return auction The auction details
     */
    function getPastAuctionDetails(
        uint256 _tokenId,
        uint256 _auctionIndex,
        uint256 _epoch
    ) external view returns (FermionTypes.AuctionDetails memory) {
        FermionTypes.Auction[] storage auctionList = Common
            ._getBuyoutAuctionStorage(_epoch)
            .tokenInfo[_tokenId]
            .auctions;
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
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(
            Common._getFermionFractionsStorage().currentEpoch
        );
        FermionTypes.Auction storage auction = Common.getLastAuction(_tokenId, $);

        uint256 fractionsPerToken = auction.details.totalFractions;
        if (fractionsPerToken == 0)
            fractionsPerToken = Common.liquidSupply(Common._getFermionFractionsStorage().currentEpoch) / $.nftCount;

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
    function getIndividualLockedVotes(uint256 _tokenId, address _voter) external view returns (uint256) {
        return
            Common
                .getLastAuction(
                    _tokenId,
                    Common._getBuyoutAuctionStorage(Common._getFermionFractionsStorage().currentEpoch)
                )
                .votes
                .individual[_voter];
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
        FermionTypes.PriceUpdateProposal storage proposal = Common
            ._getBuyoutAuctionStorage(Common._getFermionFractionsStorage().currentEpoch)
            .currentProposal;
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
    function getVoterDetails(address _voter) external view returns (FermionTypes.PriceUpdateVoter memory) {
        return
            Common._getBuyoutAuctionStorage(Common._getFermionFractionsStorage().currentEpoch).currentProposal.voters[
                _voter
            ];
    }

    /**
     * @notice Returns the liquid number of fractions for current epoch. Represents fractions of F-NFTs that are fractionalised
     */
    function liquidSupply() public view returns (uint256) {
        return Common.liquidSupply(Common._getFermionFractionsStorage().currentEpoch);
    }

    /**
     * @notice Forwards the delegate call to target, using full calldata.
     *
     * @param _target The implementation address of the voter.
     */
    function forwardCall(address _target) internal returns (bytes memory) {
        return _target.functionDelegateCall(_msgData());
    }
}
