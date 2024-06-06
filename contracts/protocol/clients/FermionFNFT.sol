// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";

import { FermionFractions } from "./FermionFractions.sol";
import { FermionWrapper } from "./FermionWrapper.sol";
import { SeaportWrapper } from "./SeaportWrapper.sol";
import { Common, TokenState } from "./Common.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

/**
 * @title Fermion F-NFT contract
 * @notice Wrapping, unwrapping, fractionalisation, buyout auction and claiming of Boson Vouchers
 *
 */
contract FermionFNFT is FermionFractions, FermionWrapper {
    constructor(
        address _bosonPriceDiscovery,
        SeaportConfig memory _seaportConfig
    ) FermionWrapper(_bosonPriceDiscovery, _seaportConfig) {}

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

    /**
     * @notice Returns the current token stat
     *
     * @param _tokenId The token id.
     * @return The token state
     */
    function tokenState(uint256 _tokenId) external view returns (TokenState) {
        return Common._getFermionCommonStorage().tokenState[_tokenId];
    }

    ///////// overrrides ///////////
    function balanceOf(address owner) public view virtual override(ERC721, FermionFractions) returns (uint256) {
        return FermionFractions.balanceOf(owner);
    }

    function balanceOfERC721(address owner) public view virtual returns (uint256) {
        return ERC721.balanceOf(owner);
    }

    function transferFrom(address from, address to, uint256 tokenIdOrValue) public virtual override(ERC721) {
        if (tokenIdOrValue > type(uint128).max) {
            ERC721.transferFrom(from, to, tokenIdOrValue);
        } else {
            bool success = transferFractionsFrom(from, to, tokenIdOrValue);
            assembly {
                return(mload(success), 32)
            }
        }
    }

    function approve(address to, uint256 tokenIdOrBalance) public virtual override(ERC721) {
        if (tokenIdOrBalance > type(uint128).max) {
            ERC721.approve(to, tokenIdOrBalance);
        } else {
            bool success = approveFractions(to, tokenIdOrBalance);
            assembly {
                return(mload(success), 32)
            }
        }
    }

    function _update(
        address _to,
        uint256 _tokenId,
        address _auth
    ) internal override(ERC721, SeaportWrapper) returns (address) {
        return SeaportWrapper._update(_to, _tokenId, _auth);
    }
}
