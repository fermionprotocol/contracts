// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.0) (token/ERC20/ERC20.sol)

pragma solidity ^0.8.20;

import { HUNDRED_PERCENT, AUCTION_END_BUFFER, MINIMAL_BID_INCREMENT } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { FermionFractionsERC20Base } from "./FermionFractionsERC20Base.sol";
import { Common, TokenState, InvalidStateOrCaller } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

/**
 * @dev Fractionalisation and buyout auction
 */
abstract contract FermionFractions is FermionFractionsERC20Base, FermionFNFTBase {
    using SafeERC20 for IERC20;

    bytes32 private constant BuyoutAuctionStorageLocation = keccak256("fermion.buyout.storage"); // ToDo: pre-calculate and store the slot

    function _getBuyoutAuctionStorage() private pure returns (BuyoutAuctionStorage storage $) {
        bytes32 position = BuyoutAuctionStorageLocation;
        assembly {
            $.slot := position
        }
    }

    function balanceOf(
        address owner
    ) public view virtual override(ERC721, FermionFractionsERC20Base) returns (uint256) {
        return FermionFractionsERC20Base.balanceOf(owner);
    }

    error InvalidFractionsAmount(uint256 amount);
    error InvalidExitPrice(uint256 amount);
    error AlreadyFractionalized(uint256 tokenId, uint256 exitPrice);
    error InvalidBid(uint256 tokenId, uint256 minimalBid, uint256 bid);
    error AuctionEnded(uint256 tokenId, uint256 endedAt);
    error AuctionNotStarted(uint256 tokenId);
    error AuctionOngoing(uint256 tokenId, uint256 validUntil);
    error NotMaxBidder(uint256 tokenId, address caller, address winner);
    error AlreadyRedeemed(uint256 tokenId);
    error NoFractions();
    error InvalidValue(uint256 expected, uint256 actual);
    error BidRemovalNotAllowed(uint256 tokenId);
    error NoBids(uint256 tokenId);
    error NotEnoughLockedVotes(uint256 tokenId, uint256 lockedVotes, uint256 requestedVotes);

    event Bid(address indexed from, uint256 newPrice, uint256 fractionsCount, uint256 bidAmount);
    event Redeemed(uint256 indexed tokenId, address indexed from);
    event Claimed(address indexed from, uint256 fractionsBurned, uint256 amountClaimed);

    uint256 internal constant MIN_FRACTIONS = 1e6;
    uint256 internal constant MAX_FRACTIONS = 1e12;
    uint256 internal constant TOP_BID_LOCK_TIME = 5 days;
    uint256 internal constant AUCTION_DURATION = 5 days;
    uint256 internal constant UNLOCK_THRESHOLD = 50_00; // 50%

    struct AuctionDetails {
        uint256 timer;
        uint256 maxBid;
        address maxBidder;
        uint256 lockedFractions;
        uint256 lockedBidAmount;
        bool started;
        bool redeemed;
    }

    struct Votes {
        uint256 total;
        mapping(address => uint256) individual;
    }

    struct BuyoutAuctionStorage {
        uint256 nftCount; // number of fractionalised NFTs
        uint256 exitPrice;
        address exchangeToken;
        mapping(uint256 => AuctionDetails) auctionDetails;
        mapping(uint256 => Votes) votes;
    }

    /////////// fractionalisation ///////////
    function mintFractions(uint256 _tokenId, uint256 _amount, uint256 _exitPrice) public virtual {
        // Is this done automatically after the check-in? Or do owner need to do it?
        // Do we make fraction amount constant? What if there are multiple items in collection?
        // ToDo: if other tokens already fractinalised, the amount must mathch totalSupply/nOf fractionalised tokens

        if (_exitPrice == 0) {
            revert InvalidExitPrice(_exitPrice);
        }

        TokenState tokenState = Common._getFermionCommonStorage().tokenState[_tokenId];
        if (tokenState != TokenState.Verified) {
            revert InvalidStateOrCaller(_tokenId, _msgSender(), tokenState);
        }

        if (_amount < MIN_FRACTIONS || _amount > MAX_FRACTIONS) {
            revert InvalidFractionsAmount(_amount);
        }

        BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        uint256 exitPrice = $.exitPrice;
        if (exitPrice > 0) {
            revert AlreadyFractionalized(_tokenId, exitPrice);
        }

        address tokenOwner = ownerOf(_tokenId);
        ERC721.transferFrom(tokenOwner, address(this), _tokenId); // ToDO: override this if protocol is calling

        $.exitPrice = _exitPrice;
        // set the token state to minted
        _mintFractions(tokenOwner, _amount);

        $.nftCount++;
    }

    function mintAdditionalFractions(uint256 _tokenId, uint256 _amount) public virtual {
        Common.checkStateAndCaller(_tokenId, TokenState.Verified, fermionProtocol);

        // set the token state to minted
        _mintFractions(fermionProtocol, _amount);
    }

    /////////// buyout aution ///////////
    function startAuction(uint256 _tokenId) internal virtual {
        AuctionDetails storage auction = _getBuyoutAuctionStorage().auctionDetails[_tokenId];
        auction.started = true;
        auction.timer = block.timestamp + AUCTION_DURATION;
    }

    // used only when the price is below the exit price
    function voteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external {
        BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        AuctionDetails storage auction = $.auctionDetails[_tokenId];

        if (auction.maxBid == 0) revert NoBids(_tokenId);
        if (auction.started) revert AuctionOngoing(_tokenId, auction.timer);

        address msgSender = _msgSender();
        _transferFractions(msgSender, address(this), _fractionAmount);

        Votes storage votes = $.votes[_tokenId];
        votes.individual[msgSender] += _fractionAmount;
        votes.total += _fractionAmount;

        if (votes.total * $.nftCount > (totalSupply() * UNLOCK_THRESHOLD) / HUNDRED_PERCENT) {
            startAuction(_tokenId);
        }
    }

    function removeVoteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external {
        BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        AuctionDetails storage auction = $.auctionDetails[_tokenId];

        if (auction.started) revert AuctionOngoing(_tokenId, auction.timer);

        Votes storage votes = $.votes[_tokenId];
        address msgSender = _msgSender();
        if (_fractionAmount > votes.individual[msgSender]) {
            // ToDo: store mapping storage
            revert NotEnoughLockedVotes(_tokenId, _fractionAmount, votes.individual[msgSender]);
        }
        _transferFractions(address(this), msgSender, _fractionAmount);

        votes.individual[msgSender] -= _fractionAmount;
        votes.total -= _fractionAmount;
    }

    // function bid(uint256 _newFractionPrice) external payable inAuction {
    function bid(uint256 _tokenId, uint256 _price) external payable {
        BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        AuctionDetails storage auction = $.auctionDetails[_tokenId];

        uint256 lastBid = auction.maxBid;
        uint256 minimalBid = (lastBid * (HUNDRED_PERCENT + MINIMAL_BID_INCREMENT)) / HUNDRED_PERCENT;
        if (_price < minimalBid) {
            revert InvalidBid(_tokenId, _price, minimalBid);
        }

        if (auction.started) {
            if (auction.timer > block.timestamp) revert AuctionEnded(_tokenId, auction.timer);
            if (auction.timer < block.timestamp + AUCTION_END_BUFFER)
                auction.timer = block.timestamp + AUCTION_END_BUFFER;
        } else {
            if (_price > $.exitPrice && $.exitPrice > 0) {
                // If price is above the exit price, the cutoff date is set
                startAuction(_tokenId);
            } else {
                // reset ticker for Unbidding
                auction.timer = block.timestamp + TOP_BID_LOCK_TIME;
            }
        }

        address exchangeToken = $.exchangeToken;
        {
            address bidder = auction.maxBidder;
            uint256 lockedFractions = auction.lockedFractions;

            // transfer to previus bidder if they used some of the fractions
            if (lockedFractions > 0) _transfer(address(this), bidder, lockedFractions);
            _safeTransfer(exchangeToken, bidder, lastBid);
        }

        Votes storage votes = $.votes[_tokenId];
        address msgSender = _msgSender();
        uint256 lockedIndividualVotes = votes.individual[msgSender];
        uint256 bidderFractions = balanceOf(msgSender) + lockedIndividualVotes;

        if (lockedIndividualVotes > 0) {
            votes.total -= lockedIndividualVotes;
            votes.individual[msgSender] = 0;
        }

        uint256 allFractions = totalSupply();
        uint256 bidAmount;
        uint256 nftCount = $.nftCount;
        if (bidderFractions * nftCount > allFractions) {
            // bidder has enough fractions to claim a full NFT without paying anything. Does a price matter in this case?
            bidderFractions = allFractions / nftCount;
        } else {
            bidAmount = ((allFractions - bidderFractions * nftCount) * _price) / allFractions;
        }

        auction.maxBidder = msgSender;
        auction.lockedFractions = bidderFractions;
        auction.maxBid = _price;

        if (bidderFractions > 0) _transfer(msgSender, address(this), bidderFractions);
        _safeTransferFrom(exchangeToken, payable(msgSender), msg.value, payable(address(this)), bidAmount);

        auction.lockedBidAmount = bidAmount;
        emit Bid(msgSender, _price, bidderFractions, bidAmount);
    }

    function removeBid(uint256 _tokenId) external {
        BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        AuctionDetails storage auction = $.auctionDetails[_tokenId];

        if (auction.started || auction.timer > block.timestamp) {
            revert BidRemovalNotAllowed(_tokenId);
        }

        address msgSender = _msgSender();
        if (msgSender != auction.maxBidder) {
            revert NotMaxBidder(_tokenId, msgSender, auction.maxBidder);
        }

        // auction has not started yet, and the timeout passed
        uint256 lockedFractions = auction.lockedFractions;
        if (lockedFractions > 0) _burn(address(this), lockedFractions);
        uint256 bidAmount = auction.lockedBidAmount;
        _safeTransfer($.exchangeToken, msgSender, bidAmount);

        emit Bid(address(0), 0, 0, 0);
    }

    function redeem(uint256 _tokenId) external {
        BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        AuctionDetails storage auction = $.auctionDetails[_tokenId];

        if (auction.started) {
            if (auction.timer <= block.timestamp) revert AuctionOngoing(_tokenId, auction.timer);
        } else {
            revert AuctionNotStarted(_tokenId);
        }

        address msgSender = _msgSender();

        if (msgSender != auction.maxBidder) {
            revert NotMaxBidder(_tokenId, msgSender, auction.maxBidder);
        }

        if (auction.redeemed) revert AlreadyRedeemed(_tokenId);
        auction.redeemed = true;
        uint256 lockedFractions = auction.lockedFractions;
        if (lockedFractions > 0) _burn(address(this), lockedFractions);
        _safeTransfer(address(this), msgSender, _tokenId);
        $.nftCount--;
        emit Redeemed(_tokenId, msgSender);
    }

    // claim proceeds of a specific auction (possible only if some other items are stil fractionalised)
    function claim(uint256 _tokenId) external {
        BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        AuctionDetails storage auction = $.auctionDetails[_tokenId];

        if (auction.started) {
            if (auction.timer <= block.timestamp) revert AuctionOngoing(_tokenId, auction.timer);
        } else {
            revert AuctionNotStarted(_tokenId);
        }

        Votes storage votes = $.votes[_tokenId];
        address msgSender = _msgSender();
        uint256 lockedIndividualVotes = votes.individual[msgSender];
        uint256 bidderFractions = balanceOf(msgSender) + lockedIndividualVotes;

        // ToDo: max available fractions -> reduce for votes[_tokenId]

        if (lockedIndividualVotes > 0) {
            votes.total -= lockedIndividualVotes;
            votes.individual[msgSender] = 0;
        }

        if (bidderFractions == 0) {
            revert NoFractions();
        }

        uint256 allFractions = totalSupply();
        uint256 claimAmount;
        uint256 nftCount = $.nftCount;
        if (bidderFractions * nftCount > allFractions) {
            // bidder has enough fractions to claim a full NFT without paying anything. Does a price matter in this case?
            bidderFractions = allFractions / nftCount;
            claimAmount = auction.maxBid;
        } else {
            claimAmount = ((bidderFractions * nftCount) * auction.maxBid) / allFractions;
        }

        _burn(msgSender, bidderFractions);
        _safeTransfer($.exchangeToken, msgSender, claimAmount);
        emit Claimed(msgSender, bidderFractions, claimAmount);
    }

    function _safeTransfer(address _token, address payable _to, uint256 _amount) internal {
        // ToDo: if fails, make it available for withdraw

        if (_token == address(0)) {
            (bool success, bytes memory errorMessage) = _to.call{ value: _amount }("");
            if (!success) revert FermionErrors.TokenTransferFailed(_to, _amount, errorMessage);
        } else {
            IERC20(_token).safeTransfer(_to, _amount);
        }
    }

    function _safeTransferFrom(
        address _token,
        address payable _from,
        uint256 _value,
        address payable _to,
        uint256 _amount
    ) internal {
        if (_token == address(0)) {
            if (_value != _amount) revert InvalidValue(_value, _amount);
            if (_to != address(this)) _to.transfer(_amount);
        } else {
            if (_value != 0) revert InvalidValue(0, _value);
            IERC20(_token).safeTransferFrom(_from, _to, _amount);
        }
    }

    function getFractionInfo() external view returns (uint256 exitPrice, uint256 nftCount, uint256 totalSupply) {
        BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage();
        exitPrice = $.exitPrice;
        nftCount = $.nftCount;
        totalSupply = _getERC20Storage()._totalSupply;
    }
}
