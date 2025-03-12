// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FractionalisationErrors } from "../domain/Errors.sol";

error InvalidStateOrCaller(uint256 tokenId, address sender, FermionTypes.TokenState state);
event TokenStateChange(uint256 indexed tokenId, FermionTypes.TokenState state);

library Common {
    /// @custom:storage-location erc7201:fermion.common.storage
    struct CommonStorage {
        // Token state
        mapping(uint256 => FermionTypes.TokenState) tokenState;
        // Metadata URI, used for all tokens and contract URI
        string metadataUri;
        // token price for fixed-price sales
        mapping(uint256 => uint256) fixedPrice;
        // transfer validator ERC721-C
        address transferValidator;
    }

    // keccak256(abi.encode(uint256(keccak256("fermion.common.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CommonStorageLocation = 0x7d46dfbe85229102c9de7236c77f143aeebfb8807e422547099ad6d89710cd00;

    function _getFermionCommonStorage() internal pure returns (CommonStorage storage $) {
        assembly {
            $.slot := CommonStorageLocation
        }
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC721")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC721StorageLocation = 0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079300;

    function _getERC721Storage() internal pure returns (ERC721.ERC721Storage storage $) {
        assembly {
            $.slot := ERC721StorageLocation
        }
    }

    // keccak256(abi.encode(uint256(keccak256("fermion.buyout.auction.storage")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant BuyoutAuctionStorageLocation =
        0x224d6815573209d133aab26f2f52964556d2c06abbb82d0961460cd2e673cd00;

    function _getBuyoutAuctionStorage() internal pure returns (FermionTypes.BuyoutAuctionStorage storage $) {
        assembly {
            $.slot := BuyoutAuctionStorageLocation
        }
    }

    /**
     * @notice Checks if the token is in the expected state and the caller is the expected address
     *
     * Reverts if:
     * - Token is not in the expected state
     * - Caller is not the expected address
     *
     * @param _tokenId The token id
     * @param _expectedState The expected state
     * @param _caller The caller
     * @param _expectedCaller The expected caller
     */
    function checkStateAndCaller(
        uint256 _tokenId,
        FermionTypes.TokenState _expectedState,
        address _caller,
        address _expectedCaller
    ) internal view {
        FermionTypes.TokenState state = _getFermionCommonStorage().tokenState[_tokenId];
        if (state != _expectedState || _caller != _expectedCaller) {
            revert InvalidStateOrCaller(_tokenId, _caller, state);
        }
    }

    /**
     * @notice Changes the state of a token
     *
     * Emits an TokenStateChange event
     *
     * @param _tokenId The token id
     * @param _state The new state
     */
    function changeTokenState(uint256 _tokenId, FermionTypes.TokenState _state) internal {
        _getFermionCommonStorage().tokenState[_tokenId] = _state;
        emit TokenStateChange(_tokenId, _state);
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
        if (auctions.length == 0) revert FractionalisationErrors.TokenNotFractionalised(_tokenId);
        unchecked {
            return auctions[auctions.length - 1];
        }
    }
}
