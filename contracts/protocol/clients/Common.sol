// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FractionalisationErrors } from "../domain/Errors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { FermionFractionsERC20 } from "./FermionFractionsERC20.sol";

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
    }

    // keccak256(abi.encode(uint256(keccak256("fermion.common.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CommonStorageLocation = 0x7d46dfbe85229102c9de7236c77f143aeebfb8807e422547099ad6d89710cd00;

    function _getFermionCommonStorage() internal pure returns (CommonStorage storage $) {
        assembly {
            $.slot := CommonStorageLocation
        }
    }

    // keccak256(abi.encode(uint256(keccak256("fermion.fractions.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FermionFractionsStorageLocation =
        0x4a7c305e00776741ac7013c3447ca536097b753ba0aa5e566dd79e90f6126200;

    function _getFermionFractionsStorage() internal pure returns (FermionTypes.FermionFractionsStorage storage $) {
        assembly {
            $.slot := FermionFractionsStorageLocation
        }
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC721")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC721StorageLocation = 0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079300;

    function _getERC721Storage() internal pure returns (ERC721.ERC721Storage storage $) {
        assembly {
            $.slot := ERC721StorageLocation
        }
    }

    // NOTE: storing the initial buyout auction here when epoch = 0
    // keccak256(abi.encode(uint256(keccak256("fermion.buyout.auction.storage")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant BuyoutAuctionStorageLocation =
        0x224d6815573209d133aab26f2f52964556d2c06abbb82d0961460cd2e673cd00;

    // NOTE: pointer to mapping(uint256 epoch => BuyoutAuctionStorageLocation)
    // keccak256(abi.encode(uint256(keccak256("fermion.buyout.auction.storage.epochs")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant BuyoutAuctionStorageEpochsLocation =
        0x7ea90b6250b50fe4d5b733a96ceefb11247134d8b2fa5878319c586d1d546a00;

    /**
     * @notice Get the buyout auction storage for a specific epoch
     * @dev epoch = 0 is special case and stored directly in the storage location.
     *       epoch != 0 is stored in the mapping(uint256 epoch => BuyoutAuctionStorageLocation)
     *       where BuyoutAuctionStorageEpochsLocation is the mapping pointer location
     *
     * @param _epoch The epoch
     * @return $ The storage
     */
    function _getBuyoutAuctionStorage(
        uint256 _epoch
    ) internal pure returns (FermionTypes.BuyoutAuctionStorage storage $) {
        if (_epoch == 0) {
            assembly {
                $.slot := BuyoutAuctionStorageLocation
            }
        } else {
            // Calculate the storage slot directly in assembly instead of reading from storage.
            // This is more efficient and avoids the need for external storage reads.
            assembly {
                mstore(0x00, _epoch)
                mstore(0x20, BuyoutAuctionStorageEpochsLocation)
                $.slot := keccak256(0x00, 0x40)
            }
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

    /**
     * @notice Returns the liquid number of fractions for current epoch. Represents fractions of F-NFTs that are fractionalised
     * @dev This function is used in multiple contracts to calculate the available supply
     * @param _epoch The epoch to check
     * @return The liquid supply of fractions
     */
    function liquidSupply(uint256 _epoch) internal view returns (uint256) {
        address erc20Clone = _getFermionFractionsStorage().epochToClone[_epoch];
        if (erc20Clone == address(0)) return 0;

        FermionTypes.BuyoutAuctionStorage storage $ = _getBuyoutAuctionStorage(_epoch);

        return
            IERC20(erc20Clone).totalSupply() -
            $.unrestricedRedeemableSupply -
            $.lockedRedeemableSupply -
            $.pendingRedeemableSupply;
    }

    /**
     * @notice Helper function to transfer fractions between addresses
     * @param _from The address to transfer from
     * @param _to The address to transfer to
     * @param _amount The amount of fractions to transfer
     * @param _epoch The epoch of the fractions
     */
    function _transferFractions(address _from, address _to, uint256 _amount, uint256 _epoch) internal {
        FermionTypes.FermionFractionsStorage storage fractionStorage = _getFermionFractionsStorage();
        address erc20Clone = fractionStorage.epochToClone[_epoch];

        if (_from == address(this)) {
            FermionFractionsERC20(erc20Clone).transfer(_to, _amount);
        } else {
            FermionFractionsERC20(erc20Clone).transferFractionsFrom(_from, _to, _amount);
        }
    }
}
