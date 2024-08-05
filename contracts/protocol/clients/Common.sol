// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FermionTypes } from "../domain/Types.sol";

error InvalidStateOrCaller(uint256 tokenId, address sender, FermionTypes.TokenState state);
event TokenStateChange(uint256 indexed tokenId, FermionTypes.TokenState state);

library Common {
    /// @custom:storage-location erc7201:fermion.common.storage
    struct CommonStorage {
        // Token state
        mapping(uint256 => FermionTypes.TokenState) tokenState;
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

    /**
     * @notice Checks if the token is in the expected state and the caller is the expected address
     *
     * Reverts if:
     * - Token is not in the expected state
     * - Caller is not the expected address
     *
     * @param _tokenId The token id
     * @param _expectedState The expected state
     * @param _expectedCaller The expected caller
     */
    function checkStateAndCaller(
        uint256 _tokenId,
        FermionTypes.TokenState _expectedState,
        address _expectedCaller
    ) internal view {
        FermionTypes.TokenState state = _getFermionCommonStorage().tokenState[_tokenId];
        // checkStateAndCaller is called only in methods invoked by Fermion or Boson contracts, so no need to use _msgSender()
        if (state != _expectedState || msg.sender != _expectedCaller) {
            revert InvalidStateOrCaller(_tokenId, msg.sender, state);
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
}
