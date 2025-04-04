// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { FermionGeneralErrors } from "../domain/Errors.sol";
import { Common, InvalidStateOrCaller } from "./Common.sol";
import { SeaportWrapper } from "./SeaportWrapper.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";

import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IWrappedNative } from "../interfaces/IWrappedNative.sol";
import { OwnableUpgradeable as Ownable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

/**
 * @title FermionWrapper
 * @notice Wraps Boson Vouchers so they can be used with external price discovery mechanism
 *
 * It makes delegatecalls to marketplace specific wrapper implementations
 *
 */
contract FermionWrapper is FermionFNFTBase, Ownable, IFermionWrapper {
    using SafeERC20 for IERC20;
    using Address for address;
    IWrappedNative private immutable WRAPPED_NATIVE;
    address private immutable SEAPORT_WRAPPER;

    /**
     * @notice Constructor
     *
     */
    constructor(
        address _bosonPriceDiscovery,
        address _seaportWrapper,
        address _wrappedNative
    ) FermionFNFTBase(_bosonPriceDiscovery) {
        if (_wrappedNative == address(0)) revert FermionGeneralErrors.InvalidAddress();
        WRAPPED_NATIVE = IWrappedNative(_wrappedNative);
        SEAPORT_WRAPPER = _seaportWrapper;
    }

    /**
     * @notice Initializes the contract
     *
     * Reverts if:
     * - Contract is already initialized
     *
     * @param _owner The address of the owner
     * @param _metadataUri The metadata URI, used for all tokens and contract URI
     */
    function initializeWrapper(address _owner, string memory _metadataUri) internal virtual {
        Common._getFermionCommonStorage().metadataUri = _metadataUri;
        __Ownable_init(_owner);
        SEAPORT_WRAPPER.functionDelegateCall(abi.encodeCall(SeaportWrapper.wrapOpenSea, ()));
    }

    /**
     * @notice Transfers the contract ownership to a new owner
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     *
     * N.B. transferring ownership to 0 are allowed, since they can still be change via Fermion Protocol
     *
     * @param _newOwner The address of the new owner
     */
    function transferOwnership(address _newOwner) public virtual override(Ownable, IFermionWrapper) {
        if (fermionProtocol != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
        _transferOwnership(_newOwner);
    }

    /**
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * Reverts if:
     * - Caller does not own the Boson rNFTs
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrapForAuction(uint256 _firstTokenId, uint256 _length, address _to) external {
        wrap(_firstTokenId, _length, _to);
    }

    /**
     * @notice Unwraps the voucher, finalizes the auction, transfers the Boson rNFT to Fermion Protocol and F-NFT to the buyer
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function unwrap(uint256 _tokenId, SeaportTypes.AdvancedOrder calldata _buyerOrder) external {
        unwrap(_tokenId);

        finalizeAuction(_tokenId, _buyerOrder);

        Common.changeTokenState(_tokenId, FermionTypes.TokenState.Unverified); // Move to the next state

        // Transfer token to protocol
        // N.B. currently price is always 0. This is a placeholder for future use, when other PD mechanisms will be supported
        // _exchangeToken and _price should be returned from finalizeAuction
        // if (_price > 0) {
        //     IERC20(_exchangeToken).safeTransfer(BP_PRICE_DISCOVERY, _price);
        // }
    }

    /**
     * @notice Unwraps the voucher, but skip the OS auction and leave the F-NFT with the seller
     *
     * @param _tokenId The token id.
     */
    function unwrapToSelf(uint256 _tokenId, address _exchangeToken, uint256 _verifierFee) external {
        unwrap(_tokenId);

        Common.changeTokenState(_tokenId, FermionTypes.TokenState.Unverified); // Move to the next state

        if (_verifierFee > 0) {
            if (_exchangeToken == address(0)) {
                WRAPPED_NATIVE.deposit{ value: _verifierFee }();
                WRAPPED_NATIVE.transfer(BP_PRICE_DISCOVERY, _verifierFee);
            } else {
                IERC20(_exchangeToken).safeTransfer(BP_PRICE_DISCOVERY, _verifierFee);
            }
        }
    }

    /**
     * @dev See {IERC721Metadata-tokenURI}.
     */
    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        _requireOwned(tokenId);

        return contractURI();
    }

    /**
     * @notice Returns storefront-level metadata used by OpenSea.
     *
     * @return Contract metadata URI
     */
    function contractURI() public view returns (string memory) {
        return Common._getFermionCommonStorage().metadataUri;
    }

    /**
     * @notice Puts the F-NFT from wrapped to unverified state and transfers Boson rNFT to fermion protocol
     *
     * @param _tokenId The token id.
     */
    function unwrap(uint256 _tokenId) internal {
        Common.checkStateAndCaller(_tokenId, FermionTypes.TokenState.Unwrapping, msg.sender, BP_PRICE_DISCOVERY); // No need to use _msgSender(). BP_PRICE_DISCOVERY does not use meta transactions

        // transfer Boson Voucher to Fermion protocol. Not using safeTransferFrom since we are sure Fermion Protocol can handle the voucher
        IERC721(voucherAddress).transferFrom(address(this), fermionProtocol, _tokenId);
    }

    /**
     * @notice Prepares data to finalize the auction using Seaport
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function finalizeAuction(uint256 _tokenId, SeaportTypes.AdvancedOrder calldata _buyerOrder) internal {
        address wrappedVoucherOwner = ownerOf(_tokenId); // tokenId can be taken from buyer order

        uint256 _price = _buyerOrder.parameters.offer[0].startAmount;
        if (_price == 0) {
            // Skip the call to seaport
            // This is possible only if verifier fee is 0, and nothing has to be encumbered by the Boson Protocol
            // Only transfer the wrapped NFT to the buyer. Signature is not verified, since no buyer's funds are moved
            // In practice, OpensSea will not allow this, since they do not allow 0 price auctions
            address buyer = _buyerOrder.parameters.offerer;
            _safeTransfer(wrappedVoucherOwner, buyer, _tokenId);
            return;
        }

        SEAPORT_WRAPPER.functionDelegateCall(
            abi.encodeCall(SeaportWrapper.finalizeOpenSeaAuction, (_tokenId, _buyerOrder))
        );
    }

    /**
     * @notice Wrapped vouchers cannot be transferred. To transfer them, invoke a function that unwraps them first.
     *
     *
     * @param _to The address to transfer the wrapped tokens to.
     * @param _tokenId The token id.
     * @param _auth The address that is allowed to transfer the token.
     */
    function _update(address _to, uint256 _tokenId, address _auth) internal virtual override returns (address) {
        FermionTypes.TokenState state = Common._getFermionCommonStorage().tokenState[_tokenId];
        if (
            state == FermionTypes.TokenState.Wrapped ||
            (state == FermionTypes.TokenState.Unverified && _to != address(0))
        ) {
            revert InvalidStateOrCaller(_tokenId, _msgSender(), state);
        }
        return super._update(_to, _tokenId, _auth);
    }

    /**
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrap(uint256 _firstTokenId, uint256 _length, address _to) internal {
        for (uint256 i = 0; i < _length; i++) {
            uint256 tokenId = _firstTokenId + i;

            // Transfer vouchers to this contract
            // Not using safeTransferFrom since this contract is the recipient and we are sure it can handle the vouchers
            IERC721(voucherAddress).transferFrom(_msgSender(), address(this), tokenId);

            // Mint to the specified address
            _safeMint(_to, tokenId);
        }
    }

    receive() external payable {}
}
