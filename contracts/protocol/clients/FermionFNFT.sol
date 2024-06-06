// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { HUNDRED_PERCENT, AUCTION_END_BUFFER, MINIMAL_BID_INCREMENT } from "../domain/Constants.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
// import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";

import { SeaportInterface } from "seaport-types/src/interfaces/SeaportInterface.sol";
import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

import { FermionFractions } from "./FermionFractions.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionWrapper } from "./FermionWrapper.sol";
import { Common, TokenState } from "./Common.sol";

/**
 * @title Fermion F-NFT contract
 * @notice Wrapping, unwrapping, fractionalisation, buyout auction and claiming of Boson Vouchers
 *
 */
contract FermionFNFT is FermionWrapper {
    using SafeERC20 for IERC20;

    constructor(
        address _bosonPriceDiscovery,
        SeaportConfig memory _seaportConfig
    ) FermionWrapper(_bosonPriceDiscovery, _seaportConfig) {}

    /////////// overrrides ///////////
    // function balanceOf(
    //     address owner
    // ) public view virtual override(ERC721, IERC721, FermionFractions) returns (uint256) {
    //     return FermionFractions.balanceOf(owner);
    // }

    // function balanceOfERC721(address owner) public view virtual returns (uint256) {
    //     return ERC721.balanceOf(owner);
    // }

    // function transferFrom(address from, address to, uint256 tokenIdOrValue) public virtual override(ERC721, IERC721) {
    //     if (tokenIdOrValue > type(uint128).max) {
    //         ERC721.transferFrom(from, to, tokenIdOrValue);
    //     } else {
    //         bool success = transferFractionsFrom(from, to, tokenIdOrValue);
    //         assembly {
    //             return(mload(success), 32)
    //         }
    //     }
    // }

    // function approve(address to, uint256 tokenIdOrBalance) public virtual override(ERC721, IERC721) {
    //     if (tokenIdOrBalance > type(uint128).max) {
    //         ERC721.approve(to, tokenIdOrBalance);
    //     } else {
    //         bool success = approveFractions(to, tokenIdOrBalance);
    //         assembly {
    //             return(mload(success), 32)
    //         }
    //     }
    // }

    // /////////// fractionalisation ///////////
    // function mintFractions(uint256 _tokenId, uint256 _amount, uint256 _exitPrice) public virtual {
    //     // Is this done automatically after the check-in? Or do owner need to do it?
    //     // Do we make fraction amount constant? What if there are multiple items in collection?
    //     // ToDo: if other tokens already fractinalised, the amount must mathch totalSupply/nOf fractionalised tokens

    //     if (_exitPrice == 0) {
    //         revert InvalidExitPrice(_exitPrice);
    //     }

    //     if (tokenState[_tokenId] != TokenState.Verified) {
    //         revert InvalidStateOrCaller(_tokenId, _msgSender(), tokenState[_tokenId]);
    //     }

    //     if (_amount < MIN_FRACTIONS || _amount > MAX_FRACTIONS) {
    //         revert InvalidFractionsAmount(_amount);
    //     }

    //     if (exitPrice[_tokenId] > 0) {
    //         revert AlreadyFractionalized(_tokenId, exitPrice[_tokenId]);
    //     }

    //     address tokenOwner = ownerOf(_tokenId);
    //     ERC721.transferFrom(tokenOwner, address(this), _tokenId); // ToDO: override this if protocol is calling

    //     exitPrice[_tokenId] = _exitPrice;
    //     // set the token state to minted
    //     _mintFractions(tokenOwner, _amount);

    //     nftCount++;
    // }

    // function mintAdditionalFractions(uint256 _tokenId, uint256 _amount) public virtual {
    //     checkStateAndCaller(_tokenId, TokenState.Verified, fermionProtocol);

    //     // set the token state to minted
    //     _mintFractions(fermionProtocol, _amount);
    // }

    // /////////// buyout aution ///////////
    // function startAuction(uint256 _tokenId) internal virtual {
    //     auctionStarted[_tokenId] = true;
    //     auctionTimer[_tokenId] = block.timestamp + AUTCION_DURATION;
    // }

    // // used only when the price is below the exit price
    // function voteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external {
    //     if (maxBid[_tokenId] == 0) revert NoBids(_tokenId);
    //     if (auctionStarted[_tokenId]) revert AuctionOngoing(_tokenId, auctionTimer[_tokenId]);

    //     address msgSender = _msgSender();
    //     _transferFractions(msgSender, address(this), _fractionAmount);

    //     lockedVotes[msgSender][_tokenId] += _fractionAmount;
    //     votes[_tokenId] += _fractionAmount;

    //     if (votes[_tokenId] * nftCount > (totalSupply() * UNLOCK_THRESHOLD) / 10_000) {
    //         startAuction(_tokenId);
    //     }
    // }

    // function removeVoteToStartAuction(uint256 _tokenId, uint256 _fractionAmount) external {
    //     if (auctionStarted[_tokenId]) revert AuctionOngoing(_tokenId, auctionTimer[_tokenId]);

    //     address msgSender = _msgSender();
    //     if (_fractionAmount > lockedVotes[msgSender][_tokenId]) {
    //         // ToDo: store mapping storage
    //         revert NotEnoughLockedVotes(_tokenId, _fractionAmount, lockedVotes[msgSender][_tokenId]);
    //     }
    //     _transferFractions(address(this), msgSender, _fractionAmount);

    //     lockedVotes[msgSender][_tokenId] -= _fractionAmount;
    //     votes[_tokenId] -= _fractionAmount;
    // }

    // // function bid(uint256 _newFractionPrice) external payable inAuction {
    // function bid(uint256 _tokenId, uint256 _price) external payable {
    //     uint256 minimalBid = (maxBid[_tokenId] * (HUNDRED_PERCENT + MINIMAL_BID_INCREMENT)) / HUNDRED_PERCENT;
    //     if (_price < minimalBid) {
    //         revert InvalidBid(_tokenId, _price, minimalBid);
    //     }

    //     if (auctionStarted[_tokenId]) {
    //         if (auctionTimer[_tokenId] > block.timestamp) revert AuctionEnded(_tokenId, auctionTimer[_tokenId]);
    //         if (auctionTimer[_tokenId] < block.timestamp + AUCTION_END_BUFFER)
    //             auctionTimer[_tokenId] = block.timestamp + AUCTION_END_BUFFER;
    //     } else {
    //         if (_price > exitPrice[_tokenId] && exitPrice[_tokenId] > 0) {
    //             // If price is above the exit price, the cutoff date is set
    //             startAuction(_tokenId);
    //         } else {
    //             // reset ticker for Unbidding
    //             auctionTimer[_tokenId] = block.timestamp + TOP_BID_LOCK_TIME;
    //         }
    //     }

    //     address bidder = maxBidder[_tokenId];
    //     uint256 lockedFractions = lockedFractions1[_tokenId];

    //     // transfer to previus bidder if they used some of the fractions
    //     if (lockedFractions > 0) _transfer(address(this), bidder, lockedFractions);
    //     _safeTransfer(exchangeToken, bidder, maxBid[_tokenId]);

    //     address msgSender = _msgSender();
    //     uint256 bidderFractions = balanceOf(msgSender) + lockedVotes[msgSender][_tokenId];

    //     if (lockedVotes[msgSender][_tokenId] > 0) {
    //         votes[_tokenId] -= lockedVotes[msgSender][_tokenId];
    //         lockedVotes[msgSender][_tokenId] = 0;
    //     }

    //     uint256 allFractions = totalSupply();
    //     uint256 bidAmount;
    //     if (bidderFractions * nftCount > allFractions) {
    //         // bidder has enough fractions to claim a full NFT without paying anything. Does a price matter in this case?
    //         bidderFractions = allFractions / nftCount;
    //     } else {
    //         bidAmount = ((allFractions - bidderFractions * nftCount) * _price) / allFractions;
    //     }

    //     maxBidder[_tokenId] = msgSender;
    //     lockedFractions1[_tokenId] = bidderFractions;
    //     maxBid[_tokenId] = _price;

    //     if (bidderFractions > 0) _transfer(msgSender, address(this), bidderFractions);
    //     _safeTransferFrom(exchangeToken, payable(msgSender), msg.value, payable(address(this)), bidAmount);

    //     lockedBidAmount[_tokenId] = bidAmount;
    //     emit Bid(msgSender, _price, bidderFractions, bidAmount);
    // }

    // function removeBid(uint256 _tokenId) external {
    //     if (auctionStarted[_tokenId] || auctionTimer[_tokenId] > block.timestamp) {
    //         revert BidRemovalNotAllowed(_tokenId);
    //     }

    //     address msgSender = _msgSender();
    //     if (msgSender != maxBidder[_tokenId]) {
    //         revert NotMaxBidder(_tokenId, msgSender, maxBidder[_tokenId]);
    //     }

    //     // auction has not started yet, and the timeout passed
    //     uint256 lockedFractions = lockedFractions1[_tokenId];
    //     if (lockedFractions > 0) _burn(address(this), lockedFractions);
    //     uint256 bidAmount = lockedBidAmount[_tokenId];
    //     _safeTransfer(exchangeToken, msgSender, bidAmount);

    //     emit Bid(address(0), 0, 0, 0);
    // }

    // function redeem(uint256 _tokenId) external {
    //     if (auctionStarted[_tokenId]) {
    //         if (auctionTimer[_tokenId] <= block.timestamp) revert AuctionOngoing(_tokenId, auctionTimer[_tokenId]);
    //     } else {
    //         revert AuctionNotStarted(_tokenId);
    //     }

    //     address msgSender = _msgSender();

    //     if (msgSender != maxBidder[_tokenId]) {
    //         revert NotMaxBidder(_tokenId, msgSender, maxBidder[_tokenId]);
    //     }

    //     if (redeemed[_tokenId]) revert AlreadyRedeemed(_tokenId);
    //     redeemed[_tokenId] = true;
    //     uint256 lockedFractions = lockedFractions1[_tokenId];
    //     if (lockedFractions > 0) _burn(address(this), lockedFractions);
    //     _safeTransfer(address(this), msgSender, _tokenId);
    //     nftCount--;
    //     emit Redeemed(_tokenId, msgSender);
    // }

    // // claim proceeds of a specific auction (possible only if some other items are stil fractionalised)
    // function claim(uint256 _tokenId) external {
    //     if (auctionStarted[_tokenId]) {
    //         if (auctionTimer[_tokenId] <= block.timestamp) revert AuctionOngoing(_tokenId, auctionTimer[_tokenId]);
    //     } else {
    //         revert AuctionNotStarted(_tokenId);
    //     }

    //     address msgSender = _msgSender();
    //     uint256 bidderFractions = balanceOf(msgSender) + lockedVotes[msgSender][_tokenId];

    //     // ToDo: max available fractions -> reduce for votes[_tokenId]

    //     if (lockedVotes[msgSender][_tokenId] > 0) {
    //         votes[_tokenId] -= lockedVotes[msgSender][_tokenId];
    //         lockedVotes[msgSender][_tokenId] = 0;
    //     }

    //     if (bidderFractions == 0) {
    //         revert NoFractions();
    //     }

    //     uint256 allFractions = totalSupply();
    //     uint256 claimAmount;
    //     if (bidderFractions * nftCount > allFractions) {
    //         // bidder has enough fractions to claim a full NFT without paying anything. Does a price matter in this case?
    //         bidderFractions = allFractions / nftCount;
    //         claimAmount = maxBid[_tokenId];
    //     } else {
    //         claimAmount = ((bidderFractions * nftCount) * maxBid[_tokenId]) / allFractions;
    //     }

    //     _burn(msgSender, bidderFractions);
    //     _safeTransfer(exchangeToken, msgSender, claimAmount);
    //     emit Claimed(msgSender, bidderFractions, claimAmount);
    // }

    // function _safeTransfer(address _token, address payable _to, uint256 _amount) internal {
    //     // ToDo: if fails, make it available for withdraw

    //     if (_token == address(0)) {
    //         (bool success, bytes memory errorMessage) = _to.call{ value: _amount }("");
    //         if (!success) revert FermionErrors.TokenTransferFailed(_to, _amount, errorMessage);
    //     } else {
    //         IERC20(_token).safeTransfer(_to, _amount);
    //     }
    // }

    // function _safeTransferFrom(
    //     address _token,
    //     address payable _from,
    //     uint256 _value,
    //     address payable _to,
    //     uint256 _amount
    // ) internal {
    //     if (_token == address(0)) {
    //         if (_value != _amount) revert InvalidValue(_value, _amount);
    //         if (_to != address(this)) _to.transfer(_amount);
    //     } else {
    //         if (_value != 0) revert InvalidValue(0, _value);
    //         IERC20(_token).safeTransferFrom(_from, _to, _amount);
    //     }
    // }

    /**
     * @notice Initializes the contract
     *
     * Reverts if:
     * - Contract is already initialized
     *
     * @param _voucherAddress The address of the Boson Voucher contract
     * @param _owner The address of the owner
     */
    function initialize(address _voucherAddress, address _owner) external initializer {
        fermionProtocol = msg.sender;
        voucherAddress = _voucherAddress;

        initializeWrapper(_owner);
    }

    /**
     * @dev Returns true if this contract implements the interface defined by
     * `interfaceId`. See the corresponding
     * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[EIP section]
     * to learn more about how these ids are created.
     */
    function supportsInterface(bytes4 _interfaceId) public view virtual override returns (bool) {
        return super.supportsInterface(_interfaceId) || _interfaceId == type(IFermionWrapper).interfaceId;
    }

    /**
     * @notice Burns the token and returns the voucher owner
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     * - Token is not in the Unverified state
     *
     * @param _tokenId The token id.
     */
    function burn(uint256 _tokenId) external returns (address wrappedVoucherOwner) {
        Common.checkStateAndCaller(_tokenId, TokenState.Unverified, fermionProtocol);

        wrappedVoucherOwner = ownerOf(_tokenId);

        _burn(_tokenId);
        Common.changeTokenState(_tokenId, TokenState.Burned);
    }

    /**
     * @notice Pushes the F-NFT from unverified to verified
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     * - The new token state is not consecutive to the current state
     *
     * N.B. Not checking if the new state is valid, since the caller is the Fermion Protocol, which is trusted
     *
     * @param _tokenId The token id.
     */
    function pushToNextTokenState(uint256 _tokenId, TokenState _newState) external {
        Common.checkStateAndCaller(_tokenId, TokenState(uint8(_newState) - 1), fermionProtocol);
        Common.changeTokenState(_tokenId, _newState);
        if (_newState == TokenState.CheckedOut) {
            _burn(_tokenId);
        }
    }

    function tokenState(uint256 _tokenId) external view returns (TokenState) {
        return Common._getFermionCommonStorage().tokenState[_tokenId];
    }
}
