// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HUNDRED_PERCENT, MINIMAL_BID_INCREMENT, MIN_FRACTIONS, MAX_FRACTIONS, TOP_BID_LOCK_TIME, AUCTION_DURATION, UNLOCK_THRESHOLD, MIN_QUORUM_PERCENT, MIN_GOV_VOTE_DURATION, MAX_GOV_VOTE_DURATION, DEFAULT_GOV_VOTE_DURATION } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionFractionsERC20Base } from "./FermionFractionsERC20Base.sol";
import { Common, InvalidStateOrCaller } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { IFermionCustodyVault } from "../interfaces/IFermionCustodyVault.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IPriceOracleRegistry } from "../interfaces/IPriceOracleRegistry.sol";

/**
 * @dev Fractionalisation and buyout auction
 */
abstract contract FermionFractions is
    FermionFractionsERC20Base,
    FermionFNFTBase,
    FermionErrors,
    IFermionFractionsEvents,
    IFermionFractions
{
    // keccak256(abi.encode(uint256(keccak256("fermion.buyout.auction.storage")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant BuyoutAuctionStorageLocation =
        0x224d6815573209d133aab26f2f52964556d2c06abbb82d0961460cd2e673cd00;

    function _getBuyoutAuctionStorage() private pure returns (FermionTypes.BuyoutAuctionStorage storage $) {
        assembly {
            $.slot := BuyoutAuctionStorageLocation
        }
    }

    /**
     * @notice Initializes the contract
     *
     * @param _exchangeToken The address of the exchange token
     */
    function intializeFractions(address _exchangeToken) internal virtual {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        $.exchangeToken = _exchangeToken;
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
        if (_length == 0) {
            revert InvalidLength();
        }

        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        if ($.nftCount > 0) {
            revert InitialFractionalisationOnly();
        }

        if (_buyoutAuctionParameters.exitPrice == 0) {
            revert InvalidExitPrice(_buyoutAuctionParameters.exitPrice);
        }

        if (_buyoutAuctionParameters.unlockThreshold > HUNDRED_PERCENT) {
            revert InvalidPercentage(_buyoutAuctionParameters.unlockThreshold);
        }

        if (_fractionsAmount < MIN_FRACTIONS || _fractionsAmount > MAX_FRACTIONS) {
            revert InvalidFractionsAmount(_fractionsAmount, MIN_FRACTIONS, MAX_FRACTIONS);
        }

        if (
            _custodianVaultParameters.newFractionsPerAuction < MIN_FRACTIONS ||
            _custodianVaultParameters.newFractionsPerAuction > MAX_FRACTIONS
        ) {
            revert InvalidFractionsAmount(
                _custodianVaultParameters.newFractionsPerAuction,
                MIN_FRACTIONS,
                MAX_FRACTIONS
            );
        }

        if (_custodianVaultParameters.partialAuctionThreshold < _custodianVaultParameters.liquidationThreshold)
            revert InvalidPartialAuctionThreshold();

        lockNFTsAndMintFractions(_firstTokenId, _length, _fractionsAmount, $);

        if (_priceOracle != address(0)) {
            _ensureOracleApproved(_priceOracle);
            $.priceOracle = _priceOracle;
        }

        // set the default values if not provided
        if (_buyoutAuctionParameters.duration == 0) _buyoutAuctionParameters.duration = AUCTION_DURATION;
        if (_buyoutAuctionParameters.unlockThreshold == 0) _buyoutAuctionParameters.unlockThreshold = UNLOCK_THRESHOLD;
        if (_buyoutAuctionParameters.topBidLockTime == 0) _buyoutAuctionParameters.topBidLockTime = TOP_BID_LOCK_TIME;

        $.auctionParameters = _buyoutAuctionParameters;

        emit FractionsSetup(_fractionsAmount, _buyoutAuctionParameters);

        address msgSender = _msgSender();
        if (msgSender != fermionProtocol) {
            moveDepositToFermionProtocol(_depositAmount, $);
            uint256 returnedAmount = IFermionCustodyVault(fermionProtocol).setupCustodianOfferVault(
                _firstTokenId,
                _length,
                _custodianVaultParameters,
                _depositAmount
            );
            if (returnedAmount > 0)
                FundsLib.transferFundsFromProtocol($.exchangeToken, payable(msgSender), returnedAmount);
        }
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
        if (_length == 0) {
            revert InvalidLength();
        }

        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        uint256 nftCount = $.nftCount;
        if (nftCount == 0) {
            revert MissingFractionalisation();
        }

        uint256 fractionsAmount = liquidSupply() / nftCount;

        lockNFTsAndMintFractions(_firstTokenId, _length, fractionsAmount, $);

        address msgSender = _msgSender();
        if (msgSender != fermionProtocol) {
            moveDepositToFermionProtocol(_depositAmount, $);
            uint256 returnedAmount = IFermionCustodyVault(fermionProtocol).addItemToCustodianOfferVault(
                _firstTokenId,
                _length,
                _depositAmount
            );
            if (returnedAmount > 0)
                FundsLib.transferFundsFromProtocol($.exchangeToken, payable(msgSender), returnedAmount);
        }
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
        if (_msgSender() != fermionProtocol) {
            revert AccessDenied(_msgSender());
        }

        _mintFractions(fermionProtocol, _amount);

        emit AdditionalFractionsMinted(_amount, liquidSupply());
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
        if (_fractionAmount == 0) revert InvalidAmount();

        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.Auction storage auction = getLastAuction(_tokenId, $);
        FermionTypes.AuctionDetails storage auctionDetails = auction.details;

        if (!$.tokenInfo[_tokenId].isFractionalised) revert TokenNotFractionalised(_tokenId);

        FermionTypes.AuctionState auctionState = auctionDetails.state;

        address msgSender = _msgSender();
        if (auctionDetails.maxBidder == msgSender) revert MaxBidderCannotVote(_tokenId);

        uint256 fractionsPerToken = auctionState >= FermionTypes.AuctionState.Ongoing
            ? auctionDetails.totalFractions
            : liquidSupply() / $.nftCount;

        FermionTypes.Votes storage votes = auction.votes;
        uint256 availableFractions = fractionsPerToken - votes.total - auctionDetails.lockedFractions;

        if (availableFractions == 0) revert NoFractionsAvailable(_tokenId);

        if (_fractionAmount > availableFractions) _fractionAmount = availableFractions;

        _transferFractions(msgSender, address(this), _fractionAmount);

        votes.individual[msgSender] += _fractionAmount;
        votes.total += _fractionAmount;

        if (auctionDetails.state == FermionTypes.AuctionState.NotStarted) {
            if (votes.total >= (fractionsPerToken * $.auctionParameters.unlockThreshold) / HUNDRED_PERCENT) {
                // NB: although in theory it's acceptable to start the auction without any bids, there could be
                // a racing situation where one user bids under the exit price, another user votes to start the auction and the first
                // user removes the bid. To avoid this, at least one bid must exist.
                if (auctionDetails.maxBid == 0) revert NoBids(_tokenId);

                startAuction(_tokenId);
            }
        }

        emit Voted(_tokenId, msgSender, _fractionAmount);
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

        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.Auction storage auction = getLastAuction(_tokenId, $);
        FermionTypes.AuctionDetails storage auctionDetails = auction.details;

        address msgSender = _msgSender();
        if (auctionDetails.maxBidder == msgSender) revert MaxBidderCannotVote(_tokenId);
        if (auctionDetails.state >= FermionTypes.AuctionState.Ongoing)
            revert AuctionOngoing(_tokenId, auctionDetails.timer);

        FermionTypes.Votes storage votes = auction.votes;
        if (_fractionAmount > votes.individual[msgSender]) {
            revert NotEnoughLockedVotes(_tokenId, _fractionAmount, votes.individual[msgSender]);
        }
        _transferFractions(address(this), msgSender, _fractionAmount);

        unchecked {
            votes.individual[msgSender] -= _fractionAmount;
            votes.total -= _fractionAmount;
        }

        emit VoteRemoved(_tokenId, msgSender, _fractionAmount);
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
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        if (!$.tokenInfo[_tokenId].isFractionalised) revert TokenNotFractionalised(_tokenId);

        FermionTypes.Auction storage auction = getLastAuction(_tokenId, $);
        FermionTypes.AuctionDetails storage auctionDetails = auction.details;
        if (auctionDetails.state == FermionTypes.AuctionState.Reserved) revert AuctionReserved(_tokenId);

        uint256 minimalBid;
        {
            uint256 maxBid = auctionDetails.maxBid;
            minimalBid = (maxBid * (HUNDRED_PERCENT + MINIMAL_BID_INCREMENT)) / HUNDRED_PERCENT;

            // due to rounding errors, the minimal bid can be equal to the max bid. Ensure strict increase.
            if (minimalBid == maxBid) minimalBid += 1;
        }

        if (_price < minimalBid) {
            revert InvalidBid(_tokenId, _price, minimalBid);
        }

        uint256 fractionsPerToken;
        {
            FermionTypes.BuyoutAuctionParameters storage auctionParameters = $.auctionParameters;
            if (auctionDetails.state >= FermionTypes.AuctionState.Ongoing) {
                if (block.timestamp > auctionDetails.timer) revert AuctionEnded(_tokenId, auctionDetails.timer);

                fractionsPerToken = auctionDetails.totalFractions;
            } else {
                fractionsPerToken = liquidSupply() / $.nftCount;
                if (_price > auctionParameters.exitPrice && auctionParameters.exitPrice > 0) {
                    // If price is above the exit price, the cutoff date is set
                    startAuction(_tokenId);
                } else {
                    // reset ticker for Unbidding
                    auctionDetails.timer = block.timestamp + auctionParameters.topBidLockTime;
                }
            }
        }

        // Return to the previous bidder the fractions and the bid
        address exchangeToken = $.exchangeToken;
        payOutLastBidder(auctionDetails, exchangeToken);

        FermionTypes.Votes storage votes = auction.votes;
        uint256 availableFractions = fractionsPerToken - votes.total; // available fractions to additionaly be used in bid

        address msgSender = _msgSender();
        uint256 bidAmount;
        if (_fractions >= availableFractions) {
            // Bidder has enough fractions to claim the remaining fractions. In this case they win the auction at the current price.
            // If the locked fractions belong to other users, the bidder must still pay the corresponding price.
            _fractions = availableFractions;

            if (auctionDetails.state == FermionTypes.AuctionState.NotStarted) startAuction(_tokenId);
            auctionDetails.state = FermionTypes.AuctionState.Reserved;
        }

        uint256 totalLockedFractions;
        unchecked {
            totalLockedFractions = _fractions + votes.individual[msgSender]; // cannot overflow, since _fractions <= availableFractions = fractionsPerToken - votes.total
            bidAmount = ((fractionsPerToken - totalLockedFractions) * _price) / fractionsPerToken; // cannot overflow, since fractionsPerToken >= totalLockedFractions
        }

        auctionDetails.maxBidder = msgSender;
        auctionDetails.lockedFractions = _fractions; // locked in addition to the votes. If outbid, this is released back to the bidder
        auctionDetails.maxBid = _price;

        if (_fractions > 0) _transferFractions(msgSender, address(this), _fractions);
        if (bidAmount > 0) FundsLib.validateIncomingPayment(exchangeToken, bidAmount);

        auctionDetails.lockedBidAmount = bidAmount;
        emit Bid(_tokenId, msgSender, _price, totalLockedFractions, bidAmount);
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
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.Auction storage auction = getLastAuction(_tokenId, $);
        FermionTypes.AuctionDetails storage auctionDetails = auction.details;

        if (auctionDetails.state >= FermionTypes.AuctionState.Ongoing || auctionDetails.timer > block.timestamp) {
            revert BidRemovalNotAllowed(_tokenId);
        }

        address msgSender = _msgSender();
        if (msgSender != auctionDetails.maxBidder) {
            revert NotMaxBidder(_tokenId, msgSender, auctionDetails.maxBidder);
        }

        // auction has not started yet, and the timeout passed
        payOutLastBidder(auctionDetails, $.exchangeToken);

        delete auction.details;

        emit Bid(0, address(0), 0, 0, 0);
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
        FermionTypes.AuctionDetails storage auction = finalizeAuction(_tokenId);

        address msgSender = _msgSender();

        if (msgSender != auction.maxBidder) {
            revert NotMaxBidder(_tokenId, msgSender, auction.maxBidder);
        }

        if (auction.state == FermionTypes.AuctionState.Redeemed) revert AlreadyRedeemed(_tokenId);
        auction.state = FermionTypes.AuctionState.Redeemed;

        ERC721._safeTransfer(address(this), msgSender, _tokenId);

        emit Redeemed(_tokenId, msgSender);
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
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.TokenAuctionInfo storage tokenInfo = $.tokenInfo[_tokenId];
        FermionTypes.Auction[] storage auctionList = tokenInfo.auctions;
        uint256 numberOfAuctions = auctionList.length; // it can be greater than one if the item was fractionalized multiple times
        if (numberOfAuctions == _auctionIndex + 1) {
            finalizeAuction(_tokenId);
        } else if (_auctionIndex >= numberOfAuctions) {
            revert InvalidAuctionIndex(_auctionIndex, numberOfAuctions);
        }

        FermionTypes.Votes storage votes = auctionList[_auctionIndex].votes;
        address msgSender = _msgSender();
        uint256 lockedIndividualVotes = votes.individual[msgSender];
        if (lockedIndividualVotes + _additionalFractions == 0) {
            revert NoFractions();
        }

        uint256 claimAmount;
        if (lockedIndividualVotes > 0) {
            votes.individual[msgSender] = 0;

            uint256 lockedAmount = uint256(tokenInfo.lockedProceeds[_auctionIndex]); // at this point it is guaranteed to be positive
            claimAmount = (lockedAmount * lockedIndividualVotes) / votes.total;

            tokenInfo.lockedProceeds[_auctionIndex] -= int256(claimAmount);
            votes.total -= lockedIndividualVotes;
            $.lockedRedeemableSupply -= lockedIndividualVotes;

            _burn(address(this), lockedIndividualVotes);
        }

        if (_additionalFractions > 0) {
            (uint256 additionalClaimAmount, uint256 burnedFractions) = burnUnrestrictedFractions(
                msgSender,
                _additionalFractions,
                $
            );
            _additionalFractions = burnedFractions;
            claimAmount += additionalClaimAmount;
        }

        FundsLib.transferFundsFromProtocol($.exchangeToken, payable(msgSender), claimAmount);
        emit Claimed(msgSender, lockedIndividualVotes + _additionalFractions, claimAmount);
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
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        if (_fractions == 0) {
            revert InvalidAmount();
        }

        address msgSender = _msgSender();
        (uint256 claimAmount, uint256 burnedFractions) = burnUnrestrictedFractions(msgSender, _fractions, $);

        FundsLib.transferFundsFromProtocol($.exchangeToken, payable(msgSender), claimAmount);
        emit Claimed(msgSender, burnedFractions, claimAmount);
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
        finalizeAuction(_tokenId);
        claim(_fractions);
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
     * @notice Returns the liquid number of fractions. Represents fractions of F-NFTs that are fractionalised
     */
    function liquidSupply() public view virtual returns (uint256) {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        return totalSupply() - $.unrestricedRedeemableSupply - $.lockedRedeemableSupply - $.pendingRedeemableSupply;
    }

    /**
     * @notice Returns the buyout auction parameters
     */
    function getBuyoutAuctionParameters() external view returns (FermionTypes.BuyoutAuctionParameters memory) {
        return _getBuyoutAuctionStorage().auctionParameters;
    }

    /**
     * @notice Returns the auction details
     *
     * @param _tokenId The token Id
     * @return auction The auction details
     */
    function getAuctionDetails(uint256 _tokenId) external view returns (FermionTypes.AuctionDetails memory) {
        return getLastAuction(_tokenId, _getBuyoutAuctionStorage()).details;
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
        FermionTypes.Auction[] storage auctionList = _getBuyoutAuctionStorage().tokenInfo[_tokenId].auctions;
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
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.Auction storage auction = getLastAuction(_tokenId, $);

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
        return getLastAuction(_tokenId, _getBuyoutAuctionStorage()).votes.individual[_voter];
    }

    /**
     * @notice Updates the exit price using either an oracle or a governance proposal.
     *         If the oracle provides a valid price, it is updated directly; otherwise,
     *         a governance proposal is created.
     *
     * @dev Only callable by fraction owners.
     *      If an oracle is set, the price is fetched and used if valid; otherwise, the fallback
     *      governance proposal mechanism is used.
     *
     * Emits:
     * - `ExitPriceUpdated` if the exit price is updated via the oracle.
     * - `PriceUpdateProposalCreated` if a governance proposal is created.
     *
     * @param newPrice The proposed new exit price.
     * @param quorumPercent The required quorum percentage for the governance proposal (in basis points).
     * @param voteDuration The duration of the governance proposal in seconds.
     *
     * Reverts:
     * - `OnlyFractionOwner()` if the caller is not a fraction owner.
     * - `InvalidQuorumPercent()` if the quorumPercent is outside the allowed range.
     * - `InvalidVoteDuration()` if the voteDuration is outside the allowed range.
     * - `OngoingProposalExists()` if there is an active proposal.
     * - `OracleInternalError()` if oracle getPrice reverts with error different than InvalidPrice()
     * - `PriceOracleNotWhitelisted()` if oracle is not whitelisted in the registry
     */
    function updateExitPrice(uint256 newPrice, uint256 quorumPercent, uint256 voteDuration) external {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();

        if (balanceOf(_msgSender()) == 0) {
            revert OnlyFractionOwner();
        }

        if (quorumPercent < MIN_QUORUM_PERCENT || quorumPercent > HUNDRED_PERCENT) {
            revert InvalidPercentage(quorumPercent);
        }

        if (voteDuration == 0) {
            voteDuration = DEFAULT_GOV_VOTE_DURATION;
        } else if (voteDuration < MIN_GOV_VOTE_DURATION || voteDuration > MAX_GOV_VOTE_DURATION) {
            revert InvalidVoteDuration(voteDuration);
        }

        if ($.currentProposal.state == FermionTypes.PriceUpdateProposalState.Active) {
            revert OngoingProposalExists();
        }

        address oracle = $.priceOracle;
        if (oracle != address(0)) {
            _ensureOracleApproved(oracle);

            try IPriceOracle(oracle).getPrice() returns (uint256 oraclePrice) {
                $.auctionParameters.exitPrice = oraclePrice;
                emit ExitPriceUpdated(oraclePrice, true);
                return;
            } catch (bytes memory reason) {
                if (!_isInvalidPriceError(reason)) {
                    revert OracleInternalError();
                }
            }
        }

        $.currentProposal.proposalId += 1;
        $.currentProposal.newExitPrice = newPrice;
        $.currentProposal.votingDeadline = block.timestamp + voteDuration;
        $.currentProposal.quorumPercent = quorumPercent;
        $.currentProposal.yesVotes = 0;
        $.currentProposal.noVotes = 0;
        $.currentProposal.state = FermionTypes.PriceUpdateProposalState.Active;

        emit PriceUpdateProposalCreated(
            $.currentProposal.proposalId,
            newPrice,
            $.currentProposal.votingDeadline,
            quorumPercent
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
     * @param voteYes True to vote YES, false to vote NO.
     */
    function voteOnProposal(bool voteYes) external {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.PriceUpdateProposal storage proposal = $.currentProposal;

        if (proposal.state != FermionTypes.PriceUpdateProposalState.Active)
            revert ProposalNotActive(proposal.proposalId);

        if (!_finalizeProposal(proposal)) {
            uint256 balance = FermionFractionsERC20Base.balanceOf(_msgSender());
            if (balance == 0) revert NoVotingPower(_msgSender());

            FermionTypes.PriceUpdateVoter storage voter = proposal.voters[_msgSender()];
            uint256 additionalVotes = balance > voter.voteCount ? balance - voter.voteCount : 0;

            if (voter.hasVoted && voter.proposalId == proposal.proposalId) {
                if (voter.votedYes != voteYes) revert ConflictingVote();
                if (additionalVotes == 0) revert AlreadyVoted();
                voter.voteCount += additionalVotes;
            } else {
                voter.proposalId = proposal.proposalId;
                voter.hasVoted = true;
                voter.votedYes = voteYes;
                voter.voteCount = balance;
                additionalVotes = balance;
            }

            if (voteYes) proposal.yesVotes += additionalVotes;
            else proposal.noVotes += additionalVotes;

            emit PriceUpdateVoted(proposal.proposalId, _msgSender(), balance, voteYes);
        }
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
        FermionTypes.PriceUpdateProposal storage proposal = _getBuyoutAuctionStorage().currentProposal;
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
     * @param voter The address of the voter.
     * @return proposalId id of proposal voter has voted
     * @return hasVoted Whether the voter has cast their vote.
     * @return votedYes Whether the voter voted in favor (true) or against (false).
     * @return voteCount The number of votes the voter has cast.
     */
    function getVoterDetails(
        address voter
    ) external view returns (uint256 proposalId, bool hasVoted, bool votedYes, uint256 voteCount) {
        FermionTypes.PriceUpdateProposal storage currentProposal = _getBuyoutAuctionStorage().currentProposal;
        FermionTypes.PriceUpdateVoter storage voterDetails = currentProposal.voters[voter];

        return (voterDetails.proposalId, voterDetails.hasVoted, voterDetails.votedYes, voterDetails.voteCount);
    }

    /**
     * @notice Finalizes a proposal by applying the following rules:
     * - A proposal is successful and `exitPrice` is updated if:
     *     1. A quorum is reached.
     *     2. `yesVotes` are greater than `noVotes`.
     * - A proposal fails if:
     *     1. Quorum is not reached.
     *     2. Quorum is reached, but `noVotes` are greater than `yesVotes`.
     *
     * Emits:
     * - `ExitPriceUpdated` if the proposal is successful.
     * - `PriceUpdateProposalFinalized` regardless of success or failure.
     *
     * @param proposal The proposal to finalize.
     * @return finalized True if the proposal was finalized, otherwise false.
     */
    function _finalizeProposal(FermionTypes.PriceUpdateProposal storage proposal) internal returns (bool finalized) {
        if (block.timestamp <= proposal.votingDeadline) {
            return false; // Proposal is still active
        }

        uint256 totalVotes = proposal.yesVotes + proposal.noVotes;
        uint256 quorumRequired = (liquidSupply() * proposal.quorumPercent) / HUNDRED_PERCENT;

        if (totalVotes >= quorumRequired) {
            if (proposal.yesVotes > proposal.noVotes) {
                proposal.state = FermionTypes.PriceUpdateProposalState.Executed;
                _getBuyoutAuctionStorage().auctionParameters.exitPrice = proposal.newExitPrice;
                emit ExitPriceUpdated(proposal.newExitPrice, false);
            } else {
                proposal.state = FermionTypes.PriceUpdateProposalState.Failed;
            }
        } else {
            proposal.state = FermionTypes.PriceUpdateProposalState.Failed;
        }

        emit PriceUpdateProposalFinalized(
            proposal.proposalId,
            proposal.state == FermionTypes.PriceUpdateProposalState.Executed
        );

        return true;
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions.
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
     */
    function lockNFTsAndMintFractions(
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _fractionsAmount,
        FermionTypes.BuyoutAuctionStorage storage $
    ) internal {
        address tokenOwner = ownerOf(_firstTokenId); // all tokens must be owned by the same address

        for (uint256 i = 0; i < _length; i++) {
            uint256 tokenId = _firstTokenId + i;
            FermionTypes.TokenState tokenState = Common._getFermionCommonStorage().tokenState[tokenId];

            if (tokenState != FermionTypes.TokenState.CheckedIn)
                revert InvalidStateOrCaller(tokenId, _msgSender(), tokenState);

            if (_msgSender() == fermionProtocol) {
                // forceful fractionalisation
                // not caching Common._getERC721Storage(), since protocol will fractionalize 1 by 1
                Common._getERC721Storage()._tokenApprovals[tokenId] = fermionProtocol;
            }

            ERC721.transferFrom(tokenOwner, address(this), tokenId);
            FermionTypes.TokenAuctionInfo storage tokenInfo = $.tokenInfo[tokenId];
            tokenInfo.isFractionalised = true;
            tokenInfo.auctions.push();

            emit Fractionalised(tokenId, _fractionsAmount);
        }

        _mintFractions(tokenOwner, _length * _fractionsAmount);

        $.nftCount += _length;
    }

    /**
     * @notice Change auction state to Ongoing and store the auction end time.
     *
     * @param _tokenId The token ID
     */
    function startAuction(uint256 _tokenId) internal virtual {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.AuctionDetails storage auctionDetails = getLastAuction(_tokenId, $).details;

        auctionDetails.state = FermionTypes.AuctionState.Ongoing;
        uint256 auctionEnd = block.timestamp + $.auctionParameters.duration;
        auctionDetails.timer = auctionEnd;

        int256 releasedFromCustodianVault = IFermionCustodyVault(fermionProtocol).removeItemFromCustodianOfferVault(
            _tokenId,
            auctionEnd
        );

        uint256 fractionsPerToken = liquidSupply() / $.nftCount;
        auctionDetails.totalFractions = fractionsPerToken;

        $.pendingRedeemableSupply += fractionsPerToken;
        $.tokenInfo[_tokenId].lockedProceeds.push(releasedFromCustodianVault);

        $.nftCount--;

        emit AuctionStarted(_tokenId, auctionDetails.timer);
    }

    /**
     * @notice Get the current auction details and votes for a specific token.
     *
     * @param _tokenId The token Id
     * @param $ The storage
     * @return auction The auction details and votes
     */
    function getLastAuction(
        uint256 _tokenId,
        FermionTypes.BuyoutAuctionStorage storage $
    ) internal view returns (FermionTypes.Auction storage auction) {
        FermionTypes.Auction[] storage auctions = $.tokenInfo[_tokenId].auctions;
        if (auctions.length == 0) revert TokenNotFractionalised(_tokenId);
        unchecked {
            return auctions[auctions.length - 1];
        }
    }

    /**
     * @notice Finalize the auction
     *
     * Reverts if:
     * - The auction has not started yet or is still ongoing
     *
     * @param _tokenId The token Id
     * @return auctionDetails The auction details
     */
    function finalizeAuction(uint256 _tokenId) internal returns (FermionTypes.AuctionDetails storage auctionDetails) {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.Auction storage auction = getLastAuction(_tokenId, $);
        auctionDetails = auction.details;

        FermionTypes.AuctionState state = auctionDetails.state;
        if (state >= FermionTypes.AuctionState.Finalized) {
            return auctionDetails;
        }

        if (state == FermionTypes.AuctionState.NotStarted) {
            revert AuctionNotStarted(_tokenId);
        }

        if (block.timestamp <= auctionDetails.timer) revert AuctionOngoing(_tokenId, auctionDetails.timer);

        FermionTypes.Votes storage votes = auction.votes;

        uint256 winnersLockedFractions;
        {
            address maxBidder = auctionDetails.maxBidder;
            uint256 winnersLockedVotes = votes.individual[maxBidder];
            winnersLockedFractions = auctionDetails.lockedFractions + winnersLockedVotes;

            votes.individual[maxBidder] = 0;
            if (winnersLockedVotes > 0) votes.total -= winnersLockedVotes;
            _burn(address(this), winnersLockedFractions);
        }

        uint256 auctionProceeds = auctionDetails.lockedBidAmount;
        uint256 fractionsPerToken = auctionDetails.totalFractions;
        FermionTypes.TokenAuctionInfo storage tokenInfo = $.tokenInfo[_tokenId];
        uint256 auctionIndex = tokenInfo.lockedProceeds.length - 1;
        int256 lockedProceeds = tokenInfo.lockedProceeds[auctionIndex];
        if (lockedProceeds < 0) {
            // custodian must be paid first
            uint256 debtFromVault = uint256(-lockedProceeds);
            if (debtFromVault > auctionProceeds) {
                // the debt in the protocol is higher than the auction proceeds
                debtFromVault = auctionProceeds;
            }
            FundsLib.transferFundsFromProtocol($.exchangeToken, payable(fermionProtocol), debtFromVault);
            IFermionCustodyVault(fermionProtocol).repayDebt(_tokenId, debtFromVault);
            auctionProceeds -= debtFromVault;
        } else {
            // something was returned from the custodian vault
            // if the max bidder has locked votes, they get are entitled to the proceeds
            uint256 releasedFromVault = uint256(lockedProceeds);
            uint256 claimAmount = (releasedFromVault * winnersLockedFractions) / fractionsPerToken;

            FundsLib.transferFundsFromProtocol($.exchangeToken, payable(auctionDetails.maxBidder), claimAmount);
            auctionProceeds += (releasedFromVault - claimAmount);
        }

        uint256 lockedVotes = votes.total;
        uint256 lockedAmount;
        if (fractionsPerToken != winnersLockedFractions) {
            lockedAmount = (lockedVotes * auctionProceeds) / (fractionsPerToken - winnersLockedFractions);
        }

        $.unrestricedRedeemableAmount += (auctionProceeds - lockedAmount);
        $.pendingRedeemableSupply -= fractionsPerToken;
        $.unrestricedRedeemableSupply += (fractionsPerToken - lockedVotes - winnersLockedFractions);
        $.lockedRedeemableSupply += lockedVotes;
        tokenInfo.lockedProceeds[auctionIndex] = int256(lockedAmount); // will be 0 or positive

        auctionDetails.state = FermionTypes.AuctionState.Finalized;

        tokenInfo.isFractionalised = false;
    }

    /**
     * @notice Calculate the amount to claim and burn the fractions.
     *
     * Reverts if:
     * - The caller has less fractions available than the amount to claim
     *
     * @param _from The address to burn the fractions from
     * @param _fractions Number of fractions to exchange for auction proceeds
     * @param $ The storage
     * @return claimAmount The amount to claim
     * @return burnedFractions The number of burned fractions
     */
    function burnUnrestrictedFractions(
        address _from,
        uint256 _fractions,
        FermionTypes.BuyoutAuctionStorage storage $
    ) internal returns (uint256 claimAmount, uint256 burnedFractions) {
        uint256 availableSupply = $.unrestricedRedeemableSupply;
        if (availableSupply == 0) revert NoFractions();

        burnedFractions = _fractions;
        if (burnedFractions > availableSupply) {
            burnedFractions = availableSupply;
        }

        claimAmount = ($.unrestricedRedeemableAmount * burnedFractions) / availableSupply;
        unchecked {
            $.unrestricedRedeemableSupply -= burnedFractions;
            $.unrestricedRedeemableAmount -= claimAmount;
        }

        _burn(_from, burnedFractions);
    }

    /**
     * @notice Pays out the last bidder. Used when the last bid is outbid or withdrawn
     *
     *
     * @param _auction The auction details
     * @param _exchangeToken The exchange token
     */
    function payOutLastBidder(FermionTypes.AuctionDetails storage _auction, address _exchangeToken) internal {
        address bidder = _auction.maxBidder;
        if (bidder == address(0)) return; // no previous bidder

        uint256 lockedFractions = _auction.lockedFractions;

        // transfer to previus bidder if they used some of the fractions. Do not transfer the locked votes.
        if (lockedFractions > 0) _transferFractions(address(this), bidder, lockedFractions);
        FundsLib.transferFundsFromProtocol(_exchangeToken, payable(bidder), _auction.lockedBidAmount);
    }

    /**
     * @notice Transfers the deposit to the Fermion Protocol during fractionalisation
     *
     * @param _depositAmount The amount to deposit
     * @param $ The storage
     */
    function moveDepositToFermionProtocol(
        uint256 _depositAmount,
        FermionTypes.BuyoutAuctionStorage storage $
    ) internal {
        if (_depositAmount > 0) {
            address exchangeToken = $.exchangeToken;
            FundsLib.validateIncomingPayment(exchangeToken, _depositAmount);
            FundsLib.transferFundsFromProtocol(exchangeToken, payable(fermionProtocol), _depositAmount);
        }
    }

    /**
     * @notice Adjusts the voter's records on transfer by removing votes associated with the transferred fractions.
     *         This ensures the proposal's vote count remains accurate.
     *
     * @dev If the voter has no active votes or the current proposal is not active, no adjustments are made.
     *      If the number of fractions being transferred exceeds the voter's vote count, only the available votes are removed.
     *
     * @param voter The address of the voter whose votes are being adjusted.
     * @param amount The number of fractions being transferred.
     */
    function _adjustVotesOnTransfer(address voter, uint256 amount) internal {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.PriceUpdateProposal storage proposal = $.currentProposal;

        if (proposal.state != FermionTypes.PriceUpdateProposalState.Active) {
            return;
        }

        FermionTypes.PriceUpdateVoter storage voterData = proposal.voters[voter];

        if (voterData.proposalId != proposal.proposalId || !voterData.hasVoted || voterData.voteCount == 0) {
            return;
        }

        uint256 votesToRemove = (amount > voterData.voteCount) ? voterData.voteCount : amount;

        if (voterData.votedYes) {
            unchecked {
                proposal.yesVotes -= votesToRemove;
            }
        } else {
            unchecked {
                proposal.noVotes -= votesToRemove;
            }
        }

        unchecked {
            voterData.voteCount -= votesToRemove;
        }

        // Clear the `hasVoted` flag only if all votes are removed
        if (voterData.voteCount == 0) {
            voterData.hasVoted = false;
        }
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
     * @notice Ensures the given oracle is approved in the oracle registry.
     *
     * Reverts if:
     * - The oracle is not approved in the registry.
     *
     * @param _oracle The address of the price oracle to check.
     */
    function _ensureOracleApproved(address _oracle) internal view {
        if (!IPriceOracleRegistry(fermionProtocol).isPriceOracleApproved(_oracle)) {
            revert PriceOracleNotWhitelisted(_oracle);
        }
    }
}
