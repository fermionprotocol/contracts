// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HUNDRED_PERCENT, MINIMAL_BID_INCREMENT } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Common } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FundsManager } from "../bases/mixins/FundsManager.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";
import { IFermionCustodyVault } from "../interfaces/IFermionCustodyVault.sol";
import { IFermionBuyoutAuction } from "../interfaces/IFermionBuyoutAuction.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { FundsFacet } from "../facets/Funds.sol";
import { FermionFractionsERC20 } from "./FermionFractionsERC20.sol";
/**
 * @dev Buyout auction
 */
contract FermionBuyoutAuction is
    FermionFNFTBase,
    FermionErrors,
    FundsManager,
    IFermionBuyoutAuction,
    IFermionFractionsEvents
{
    using Address for address;
    constructor(
        address _bosonPriceDiscovery,
        address _fermionProtocol
    ) FermionFNFTBase(_bosonPriceDiscovery, _fermionProtocol) {}

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
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(
            Common._getFermionFractionsStorage().currentEpoch
        );
        FermionTypes.AuctionDetails storage auctionDetails = Common.getLastAuction(_tokenId, $).details;

        bool isProtocolCaller = FERMION_PROTOCOL == _msgSender();

        if (!$.tokenInfo[_tokenId].isFractionalised) {
            if (isProtocolCaller) return; // if protocol tries to start an auction for a non-fractionalised token, just return
            revert TokenNotFractionalised(_tokenId);
        }

        if (auctionDetails.state != FermionTypes.AuctionState.NotStarted) {
            revert AuctionOngoing(_tokenId, auctionDetails.timer);
        }

        uint256 exitPrice = $.auctionParameters.exitPrice;
        uint256 maxBid = auctionDetails.maxBid;
        if (maxBid < exitPrice && !isProtocolCaller) {
            // protocol can start the auction even if the highest bid is below the exit price
            revert BidBelowExitPrice(_tokenId, maxBid, exitPrice);
        }

        startAuctionInternal(_tokenId);
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
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(
            Common._getFermionFractionsStorage().currentEpoch
        );
        if (!$.tokenInfo[_tokenId].isFractionalised) revert TokenNotFractionalised(_tokenId);

        FermionTypes.Auction storage auction = Common.getLastAuction(_tokenId, $);
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
                fractionsPerToken = Common.liquidSupply(Common._getFermionFractionsStorage().currentEpoch) / $.nftCount;
                if (_price >= auctionParameters.exitPrice && auctionParameters.exitPrice > 0) {
                    // If price is above the exit price, the cutoff date is set
                    startAuctionInternal(_tokenId);
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

            if (auctionDetails.state == FermionTypes.AuctionState.NotStarted) startAuctionInternal(_tokenId);
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

        if (_fractions > 0) {
            Common._transferFractions(
                msgSender,
                address(this),
                _fractions,
                Common._getFermionFractionsStorage().currentEpoch
            );
        }
        if (bidAmount > 0) {
            validateIncomingPayment(exchangeToken, bidAmount);
        }

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
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(
            Common._getFermionFractionsStorage().currentEpoch
        );
        FermionTypes.Auction storage auction = Common.getLastAuction(_tokenId, $);
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
        uint256 currentEpoch = Common._getFermionFractionsStorage().currentEpoch;
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);
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

            _burnFractions(address(this), lockedIndividualVotes, currentEpoch);
        }

        if (_additionalFractions > 0) {
            (uint256 additionalClaimAmount, uint256 burnedFractions) = burnUnrestrictedFractions(
                msgSender,
                _additionalFractions,
                $,
                currentEpoch
            );
            _additionalFractions = burnedFractions;
            claimAmount += additionalClaimAmount;
        }

        transferERC20FromProtocol($.exchangeToken, payable(msgSender), claimAmount);
        emit Claimed(msgSender, lockedIndividualVotes + _additionalFractions, claimAmount, currentEpoch);
    }

    /**
     * @notice Claim the auction proceeds of all finalized auctions for current epoch.
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
        uint256 currentEpoch = Common._getFermionFractionsStorage().currentEpoch;
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);
        if (_fractions == 0) {
            revert InvalidAmount();
        }

        address msgSender = _msgSender();
        (uint256 claimAmount, uint256 burnedFractions) = burnUnrestrictedFractions(
            msgSender,
            _fractions,
            $,
            currentEpoch
        );

        transferERC20FromProtocol($.exchangeToken, payable(msgSender), claimAmount);
        emit Claimed(msgSender, burnedFractions, claimAmount, currentEpoch);
    }

    /**
     * @notice Claim the auction proceeds of all finalized auctions from a specific epoch.
     * This withdraws only the proceeds of already finalized auctions for a specific epoch.
     * All auctions from previous epochs should have only finalised auctions.
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
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(_epoch);
        if (_fractions == 0) {
            revert InvalidAmount();
        }
        address msgSender = _msgSender();
        (uint256 claimAmount, uint256 burnedFractions) = burnUnrestrictedFractions(msgSender, _fractions, $, _epoch);

        transferERC20FromProtocol($.exchangeToken, payable(msgSender), claimAmount);
        emit Claimed(msgSender, burnedFractions, claimAmount, _epoch);
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
     * @notice Change auction state to Ongoing and store the auction end time.
     *
     * @param _tokenId The token ID
     */
    function startAuctionInternal(uint256 _tokenId) public virtual {
        // NOTE: a small possible optimisation would be making the function internal to avoid multiple same storage read (see  function startAuction)
        uint256 currentEpoch = Common._getFermionFractionsStorage().currentEpoch;
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);
        FermionTypes.AuctionDetails storage auctionDetails = Common.getLastAuction(_tokenId, $).details;

        auctionDetails.state = FermionTypes.AuctionState.Ongoing;
        uint256 auctionEnd = block.timestamp + $.auctionParameters.duration;
        auctionDetails.timer = auctionEnd;

        uint256 fractionsPerToken = Common.liquidSupply(currentEpoch) / $.nftCount;
        auctionDetails.totalFractions = fractionsPerToken;

        $.pendingRedeemableSupply += fractionsPerToken;
        $.nftCount--;

        int256 releasedFromCustodianVault = IFermionCustodyVault(FERMION_PROTOCOL).removeItemFromCustodianOfferVault(
            _tokenId,
            auctionEnd
        );

        $.tokenInfo[_tokenId].lockedProceeds.push(releasedFromCustodianVault);

        emit AuctionStarted(_tokenId, auctionDetails.timer, currentEpoch);
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
        uint256 currentEpoch = Common._getFermionFractionsStorage().currentEpoch;
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);
        FermionTypes.Auction storage auction = Common.getLastAuction(_tokenId, $);
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
            _burnFractions(address(this), winnersLockedFractions, currentEpoch);
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
            transferERC20FromProtocol($.exchangeToken, payable(FERMION_PROTOCOL), debtFromVault);
            IFermionCustodyVault(FERMION_PROTOCOL).repayDebt(_tokenId, debtFromVault);
            auctionProceeds -= debtFromVault;
        } else {
            // something was returned from the custodian vault
            // if the max bidder has locked votes, they get are entitled to the proceeds
            uint256 releasedFromVault = uint256(lockedProceeds);
            uint256 claimAmount = (releasedFromVault * winnersLockedFractions) / fractionsPerToken;

            transferERC20FromProtocol($.exchangeToken, payable(auctionDetails.maxBidder), claimAmount);
            auctionProceeds += (releasedFromVault - claimAmount);
        }

        if (auctionProceeds > 0) {
            FundsManager.transferERC20FromProtocol($.exchangeToken, payable(FERMION_PROTOCOL), auctionProceeds);
            unchecked {
                auctionProceeds -= FundsFacet(FERMION_PROTOCOL).collectRoyalties(_tokenId, auctionProceeds);
            }
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
     * @notice Calculate the amount to claim and burn the fractions in a specific epoch.
     *
     * Reverts if:
     * - The caller has less fractions available than the amount to claim
     *
     * @param _from The address to burn the fractions from
     * @param _fractions Number of fractions to exchange for auction proceeds
     * @param $ The storage
     * @param _epoch The epoch to burn the fractions from
     * @return claimAmount The amount to claim
     * @return burnedFractions The number of burned fractions
     */
    function burnUnrestrictedFractions(
        address _from,
        uint256 _fractions,
        FermionTypes.BuyoutAuctionStorage storage $,
        uint256 _epoch
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

        _burnFractions(_from, burnedFractions, _epoch);
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
        if (lockedFractions > 0) {
            Common._transferFractions(
                address(this),
                bidder,
                lockedFractions,
                Common._getFermionFractionsStorage().currentEpoch
            );
        }
        transferERC20FromProtocol(_exchangeToken, payable(bidder), _auction.lockedBidAmount);
    }

    /**
     * @notice Burns a specific amount of fractions in a specific ERC20 Fractions clone.
     *
     * @param _from The address to burn the fractions from
     * @param _amount The amount of fractions to burn
     * @param _epoch The epoch to burn the fractions from
     */
    function _burnFractions(address _from, uint256 _amount, uint256 _epoch) internal {
        FermionFractionsERC20(Common._getFermionFractionsStorage().epochToClone[_epoch]).burn(_from, _amount);
    }
}
