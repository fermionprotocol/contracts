// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { FermionFractions } from "./FermionFractions.sol";
import { FermionWrapper } from "./FermionWrapper.sol";
import { SeaportWrapper } from "./SeaportWrapper.sol";
import { Common } from "./Common.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title Fermion F-NFT contract
 * @notice Wrapping, unwrapping, fractionalisation, buyout auction and claiming of Boson Vouchers
 *
 */
contract FermionFNFT is FermionFractions, FermionWrapper, IFermionFNFT {
    address private immutable THIS_CONTRACT = address(this);

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
     * @param _exchangeToken The address of the exchange token
     */
    function initialize(address _voucherAddress, address _owner, address _exchangeToken) external initializer {
        if (address(this) == THIS_CONTRACT) {
            revert InvalidInitialization();
        }

        fermionProtocol = msg.sender;
        voucherAddress = _voucherAddress;

        initializeWrapper(_owner);
        intializeFractions(_exchangeToken);
    }

    /**
     * @dev Returns true if this contract implements the interface defined by
     * `interfaceId`. See the corresponding
     * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[EIP section]
     * to learn more about how these ids are created.
     */
    function supportsInterface(bytes4 _interfaceId) public view virtual override(ERC721, IERC165) returns (bool) {
        return
            super.supportsInterface(_interfaceId) ||
            _interfaceId == type(IFermionWrapper).interfaceId ||
            _interfaceId == type(IFermionFractions).interfaceId ||
            _interfaceId == type(IFermionFNFT).interfaceId;
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
        Common.checkStateAndCaller(_tokenId, FermionTypes.TokenState.Unverified, fermionProtocol);

        wrappedVoucherOwner = ownerOf(_tokenId);

        _burn(_tokenId);
        Common.changeTokenState(_tokenId, FermionTypes.TokenState.Burned);
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
    function pushToNextTokenState(uint256 _tokenId, FermionTypes.TokenState _newState) external {
        Common.checkStateAndCaller(_tokenId, FermionTypes.TokenState(uint8(_newState) - 1), fermionProtocol);
        Common.changeTokenState(_tokenId, _newState);
        if (_newState == FermionTypes.TokenState.CheckedOut) {
            _burn(_tokenId);
        }
    }

    /**
     * @notice Returns the current token stat
     *
     * @param _tokenId The token id.
     * @return The token state
     */
    function tokenState(uint256 _tokenId) external view returns (FermionTypes.TokenState) {
        return Common._getFermionCommonStorage().tokenState[_tokenId];
    }

    ///////// overrides ///////////
    function balanceOf(
        address owner
    ) public view virtual override(IERC721, ERC721, FermionFractions) returns (uint256) {
        return FermionFractions.balanceOf(owner);
    }

    function balanceOfERC721(address owner) public view virtual returns (uint256) {
        return ERC721.balanceOf(owner);
    }

    function transfer(
        address to,
        uint256 value
    ) public virtual override(IFermionFractions, FermionFractions) returns (bool) {
        return FermionFractions.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 tokenIdOrValue) public virtual override(IERC721, ERC721) {
        if (tokenIdOrValue > type(uint128).max) {
            ERC721.transferFrom(from, to, tokenIdOrValue);
        } else {
            bool success = transferFractionsFrom(from, to, tokenIdOrValue);
            assembly {
                return(success, 32)
            }
        }
    }

    function approve(address to, uint256 tokenIdOrBalance) public virtual override(IERC721, ERC721) {
        if (tokenIdOrBalance > type(uint128).max) {
            ERC721.approve(to, tokenIdOrBalance);
        } else {
            bool success = approveFractions(to, tokenIdOrBalance);
            assembly {
                return(success, 32)
            }
        }
    }

    function _update(
        address _to,
        uint256 _tokenId,
        address _auth
    ) internal override(ERC721, SeaportWrapper) returns (address) {
        address from = SeaportWrapper._update(_to, _tokenId, _auth);
        if (from == address(0)) Common.changeTokenState(_tokenId, FermionTypes.TokenState.Wrapped);

        return from;
    }
}
