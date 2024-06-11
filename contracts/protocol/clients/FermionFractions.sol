// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { HUNDRED_PERCENT, AUCTION_END_BUFFER, MINIMAL_BID_INCREMENT, MIN_FRACTIONS, MAX_FRACTIONS, TOP_BID_LOCK_TIME, AUCTION_DURATION, UNLOCK_THRESHOLD } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionFractionsERC20Base } from "./FermionFractionsERC20Base.sol";
import { Common, InvalidStateOrCaller } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";

/**
 * @dev Fractionalisation and buyout auction
 */
abstract contract FermionFractions is
    FermionFractionsERC20Base,
    FermionFNFTBase,
    FermionErrors,
    IFermionFractionsEvents
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
        _getBuyoutAuctionStorage().exchangeToken = _exchangeToken;
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions. Sets the auction parameters and custodian vault parameters.
     * This function is called when the first NFT is fractionalised.
     * If some NFTs are already fractionalised, use `mintAdditionalFractions(uint256 _tokenId, uint256 _amount)` instead.
     *
     * Emits Fractionalised event if successful.
     *
     * Reverts if:
     * - Number of tokens to fractionalise is zero
     * - Other tokens are fractionalised already
     * - Exit price is zero
     * - Fractions amount is not in the range [MIN_FRACTIONS, MAX_FRACTIONS]
     * - Token state is not Verified
     * - Token has been fractionalised already
     * - Caller is neither approved to transfer the NFTs nor is the fermion protocol
     *
     * @param _firstTokenId The starting token ID
     * @param _length The number of tokens to fractionalise
     * @param _fractionsAmount The number of fractions to mint for each NFT
     * @param _buyoutAuctionParameters The buyout auction parameters
     */
    function mintFractions(
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _fractionsAmount,
        FermionTypes.BuyoutAuctionParameters memory _buyoutAuctionParameters
    ) external {
        if (_length == 0) {
            revert InvalidLength();
        }

        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        if ($.nftCount > 0) {
            // if other tokens are fractionalised already, use `mintFractions(uint256 _firstTokenId, uint256 _length)` instead
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

        lockNFTsAndMintFractions(_firstTokenId, _length, _fractionsAmount, $);

        // set the default values if not provided
        if (_buyoutAuctionParameters.duration == 0) _buyoutAuctionParameters.duration = AUCTION_DURATION;
        if (_buyoutAuctionParameters.unlockThreshold == 0) _buyoutAuctionParameters.unlockThreshold = UNLOCK_THRESHOLD;
        if (_buyoutAuctionParameters.topBidLockTime == 0) _buyoutAuctionParameters.topBidLockTime = TOP_BID_LOCK_TIME;

        $.auctionParameters = _buyoutAuctionParameters;

        emit FractionsSetup(_fractionsAmount, _buyoutAuctionParameters);

        // ToDo: call the protocol to setup the vault
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
     */
    function mintFractions(uint256 _firstTokenId, uint256 _length) external {
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

        // ToDo: call the protocol to update the vault
    }

    /**
     * @notice A fractional owners can vote to start the auction for a specific token, even if the current bid is below the exit price.
     * They need to lock their fractions to vote. The fractions can be unlocked before the auction starts.
     * The fractions can be used to bid in the auction.
     * The locked votes guarantee to get the proceeds from the auction for the specific token.
     * The auction is started when the total number of locked fractions reaches the unlock threshold.
     *
     * Emits a Voted event if successful.
     * Emits an AuctionStarted event if the auction is started.
     *
     * Reverts if:
     * - The caller is the current max bidder
     * - The auction is already ongoing
     * - The number of fractions to vote is zero
     * - The caller does not have enough fractions to vote
     *
     * @param _tokenId The token Id
     * @param _fractionAmount The number of tokens to use to vote
     */
    function voteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external {
        if (_fractionAmount == 0) revert InvalidAmount();

        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.AuctionDetails storage auction = $.auctionDetails[_tokenId];

        if (!$.isFractionalised[_tokenId]) revert TokenNotFractionalised(_tokenId);

        address msgSender = _msgSender();
        if (auction.maxBidder == msgSender) revert MaxBidderCannotVote(_tokenId);
        if (auction.state >= FermionTypes.AuctionState.Ongoing) revert AuctionOngoing(_tokenId, auction.timer);

        uint256 fractionsPerToken = liquidSupply() / $.nftCount;

        FermionTypes.Votes storage votes = getLastVotes(_tokenId, $);
        uint256 availableFractions = fractionsPerToken - votes.total;

        if (_fractionAmount > availableFractions) _fractionAmount = availableFractions;

        _transferFractions(msgSender, address(this), _fractionAmount);

        votes.individual[msgSender] += _fractionAmount;
        votes.total += _fractionAmount;

        if (votes.total > (fractionsPerToken * $.auctionParameters.unlockThreshold) / HUNDRED_PERCENT) {
            startAuction(_tokenId);
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
        FermionTypes.AuctionDetails storage auction = $.auctionDetails[_tokenId];

        address msgSender = _msgSender();
        if (auction.maxBidder == msgSender) revert MaxBidderCannotVote(_tokenId);
        if (auction.state >= FermionTypes.AuctionState.Ongoing) revert AuctionOngoing(_tokenId, auction.timer);

        FermionTypes.Votes storage votes = getLastVotes(_tokenId, $);
        if (_fractionAmount > votes.individual[msgSender]) {
            revert NotEnoughLockedVotes(_tokenId, _fractionAmount, votes.individual[msgSender]);
        }
        _transferFractions(address(this), msgSender, _fractionAmount);

        votes.individual[msgSender] -= _fractionAmount;
        votes.total -= _fractionAmount;

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
     * @param _fractions The number of fractions to use for the bid
     */
    function bid(uint256 _tokenId, uint256 _price, uint256 _fractions) external payable {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        FermionTypes.AuctionDetails storage auction = $.auctionDetails[_tokenId];
        FermionTypes.BuyoutAuctionParameters storage auctionParameters = $.auctionParameters;

        if (!$.isFractionalised[_tokenId]) revert TokenNotFractionalised(_tokenId);

        uint256 minimalBid = (auction.maxBid * (HUNDRED_PERCENT + MINIMAL_BID_INCREMENT)) / HUNDRED_PERCENT;
        if (_price < minimalBid) {
            revert InvalidBid(_tokenId, _price, minimalBid);
        }

        if (auction.state >= FermionTypes.AuctionState.Ongoing) {
            if (block.timestamp > auction.timer) revert AuctionEnded(_tokenId, auction.timer);
            if (auction.timer < block.timestamp + AUCTION_END_BUFFER)
                auction.timer = block.timestamp + AUCTION_END_BUFFER;
        } else {
            if (_price > auctionParameters.exitPrice && auctionParameters.exitPrice > 0) {
                // If price is above the exit price, the cutoff date is set
                startAuction(_tokenId);
            } else {
                // reset ticker for Unbidding
                auction.timer = block.timestamp + auctionParameters.topBidLockTime;
            }
        }

        // Return to the previous bidder the fractions and the bid
        FermionTypes.Votes storage votes = getLastVotes(_tokenId, $);
        address exchangeToken = $.exchangeToken;
        {
            payOutLastBidder(auction, votes, exchangeToken);
        }

        address msgSender = _msgSender();
        uint256 lockedIndividualVotes = votes.individual[msgSender];
        uint256 bidderFractions = _fractions + lockedIndividualVotes;

        uint256 bidAmount;
        uint256 fractionsPerToken = liquidSupply() / $.nftCount;
        if (bidderFractions > fractionsPerToken) {
            // bidder has enough fractions to claim a full NFT without paying anything. Does a price matter in this case?
            bidderFractions = fractionsPerToken;
        } else {
            bidAmount = ((fractionsPerToken - bidderFractions) * _price) / fractionsPerToken;
        }

        auction.maxBidder = msgSender;
        auction.lockedFractions = bidderFractions;
        auction.maxBid = _price;

        if (_fractions > 0) _transferFractions(msgSender, address(this), bidderFractions - lockedIndividualVotes);
        FundsLib.validateIncomingPayment(exchangeToken, bidAmount);

        auction.lockedBidAmount = bidAmount;
        emit Bid(_tokenId, msgSender, _price, bidderFractions, bidAmount);
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
        FermionTypes.AuctionDetails storage auction = $.auctionDetails[_tokenId];

        if (auction.state >= FermionTypes.AuctionState.Ongoing || auction.timer > block.timestamp) {
            revert BidRemovalNotAllowed(_tokenId);
        }

        address msgSender = _msgSender();
        if (msgSender != auction.maxBidder) {
            revert NotMaxBidder(_tokenId, msgSender, auction.maxBidder);
        }

        // auction has not started yet, and the timeout passed
        payOutLastBidder(auction, getLastVotes(_tokenId, $), $.exchangeToken);

        delete $.auctionDetails[_tokenId];

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

        uint256 lockedFractions = auction.lockedFractions;

        // Deleting the auction has two effects:
        // 1. It prevents the token to be redeemed again
        // 2. Allows the token to be fractionalized again
        delete _getBuyoutAuctionStorage().auctionDetails[_tokenId];

        if (lockedFractions > 0) _burn(address(this), lockedFractions);
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
        finalizeAuction(_tokenId);

        FermionTypes.Votes storage votes = $.votes[_tokenId][_auctionIndex];
        address msgSender = _msgSender();
        uint256 lockedIndividualVotes = votes.individual[msgSender];
        if (lockedIndividualVotes + _additionalFractions == 0) {
            revert NoFractions();
        }

        uint256 claimAmount;
        if (lockedIndividualVotes > 0) {
            votes.individual[msgSender] = 0;

            uint256 lockedAmount = $.lockedProceeds[_tokenId][_auctionIndex];
            claimAmount = (lockedAmount * lockedIndividualVotes) / votes.total;

            $.lockedProceeds[_tokenId][_auctionIndex] -= claimAmount;
            votes.total -= lockedIndividualVotes;

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
     *
     * Emits a Claimed event if successful.
     *
     * Reverts if:
     * - The amount to claim is zero
     * - The caller has less fractions available than the amount to claim
     *
     * @param _fractions Number of fractions to exchange for auction proceeds
     */
    function claim(uint256 _fractions) external {
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
     * @notice Returns the liquid number of fractions. Represents fractions of F-NFTs that are fractionalised
     */
    function liquidSupply() public view virtual returns (uint256) {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        return totalSupply() - $.unrestricedRedeemableSupply - $.lockedRedeemableSupply;
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
        return _getBuyoutAuctionStorage().auctionDetails[_tokenId];
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

        uint256 fractionsPerToken = liquidSupply() / $.nftCount;

        FermionTypes.Votes storage votes = getLastVotes(_tokenId, $);
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
        return getLastVotes(_tokenId, _getBuyoutAuctionStorage()).individual[_voter];
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
            if (tokenState != FermionTypes.TokenState.Verified)
                revert InvalidStateOrCaller(tokenId, _msgSender(), tokenState);

            if (_msgSender() == fermionProtocol) {
                // forceful fractionalisation
                // not caching Common._getERC721Storage(), since protocol will fractionalize 1 by 1
                Common._getERC721Storage()._tokenApprovals[tokenId] = fermionProtocol;
            }

            ERC721.transferFrom(tokenOwner, address(this), tokenId);
            $.isFractionalised[tokenId] = true;
            $.votes[tokenId].push();

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
        FermionTypes.AuctionDetails storage auction = $.auctionDetails[_tokenId];
        auction.state = FermionTypes.AuctionState.Ongoing;
        auction.timer = block.timestamp + $.auctionParameters.duration;

        emit AuctionStarted(_tokenId, auction.timer);
    }

    /**
     * @notice Get the current votes for a specific token.
     * If there are no votes, a new vote is created.
     *
     *
     * @param _tokenId The token Id
     * @param $ The storage
     * @return votes The votes information
     */
    function getLastVotes(
        uint256 _tokenId,
        FermionTypes.BuyoutAuctionStorage storage $
    ) internal view returns (FermionTypes.Votes storage votes) {
        FermionTypes.Votes[] storage votesList = $.votes[_tokenId];

        return votesList[votesList.length - 1];
    }

    /**
     * @notice Finalize the auction
     *
     * Reverts if:
     * - The auction has not started yet or is still ongoing
     *
     * @param _tokenId The token Id
     * @return auction The auction details
     */
    function finalizeAuction(uint256 _tokenId) internal returns (FermionTypes.AuctionDetails storage auction) {
        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        auction = $.auctionDetails[_tokenId];

        FermionTypes.AuctionState state = auction.state;
        if (state == FermionTypes.AuctionState.Finalized) {
            return auction;
        }

        if (state == FermionTypes.AuctionState.NotStarted) {
            revert AuctionNotStarted(_tokenId);
        }
        if (block.timestamp <= auction.timer) revert AuctionOngoing(_tokenId, auction.timer);

        uint256 fractionsPerToken = liquidSupply() / $.nftCount;

        FermionTypes.Votes storage votes = getLastVotes(_tokenId, $);
        address maxBidder = auction.maxBidder;
        uint256 winnersLockedVotes = votes.individual[maxBidder];
        if (winnersLockedVotes > 0) votes.individual[maxBidder] = 0;
        uint256 auctionProceeds = auction.maxBid;
        uint256 lockedVotes = votes.total - winnersLockedVotes;
        uint256 lockedAmount = (lockedVotes * auctionProceeds) / fractionsPerToken;

        $.unrestricedRedeemableSupply += fractionsPerToken - lockedVotes;
        $.unrestricedRedeemableAmount += auctionProceeds - lockedAmount;
        $.lockedRedeemableSupply += lockedVotes;
        $.lockedProceeds[_tokenId].push(lockedAmount);

        $.nftCount--;
        auction.state = FermionTypes.AuctionState.Finalized;

        $.isFractionalised[_tokenId] = false;
        if ($.nftCount == 0) {
            // allow fractionalisation with new parameters
            delete $.auctionParameters;
        }

        // ToDo: get unused amount from the custodian vault
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
        $.unrestricedRedeemableSupply -= burnedFractions;
        $.unrestricedRedeemableAmount -= claimAmount;

        _burn(_from, burnedFractions);
    }

    /**
     * @notice Pays out the last bidder. Used when the last bid is outbid or withdrawn
     *
     *
     * @param _auction The auction details
     * @param _votes The votes for the auction
     * @param _exchangeToken The exchange token
     */
    function payOutLastBidder(
        FermionTypes.AuctionDetails storage _auction,
        FermionTypes.Votes storage _votes,
        address _exchangeToken
    ) internal {
        address bidder = _auction.maxBidder;
        if (bidder == address(0)) return; // no previous bidder

        uint256 lockedIndividualVotes = _votes.individual[bidder];
        uint256 lockedFractions = _auction.lockedFractions - lockedIndividualVotes;

        // transfer to previus bidder if they used some of the fractions
        if (lockedFractions > 0) _transferFractions(address(this), bidder, lockedFractions);
        FundsLib.transferFundsFromProtocol(_exchangeToken, payable(bidder), _auction.lockedBidAmount);
    }
}
