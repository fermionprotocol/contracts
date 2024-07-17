// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { Common } from "./Common.sol";
import { SeaportWrapper } from "./SeaportWrapper.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";

import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

/**
 * @title FermionWrapper
 * @notice Wraps Boson Vouchers so they can be used with external price discovery mechanism
 *
 * It makes delegatecalls to marketplace specific wrapper implementations
 *
 */
contract FermionWrapper is SeaportWrapper, IFermionWrapper {
    using SafeERC20 for IERC20;

    /**
     * @notice Constructor
     *
     */
    constructor(
        address _bosonPriceDiscovery,
        SeaportConfig memory _seaportConfig
    ) SeaportWrapper(_bosonPriceDiscovery, _seaportConfig) {}

    /**
     * @notice Initializes the contract
     *
     * Reverts if:
     * - Contract is already initialized
     *
     * @param _owner The address of the owner
     */
    function initializeWrapper(address _owner) internal virtual {
        initialize(_owner);
        wrapOpenSea();
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

        (, address _exchangeToken) = finalizeAuction(_tokenId, _buyerOrder);

        // Transfer token to protocol
        // N.B. currently price is always 0. This is a placeholder for future use, when other PD mechanisms will be supported
        // if (price > 0) {
        //     IERC20(_exchangeToken).safeTransfer(BP_PRICE_DISCOVERY, price);
        // }

        Common._getFermionCommonStorage().exchangeToken = _exchangeToken;
    }

    /**
     * @notice Unwraps the voucher, but skip the OS auction and leave the F-NFT with the seller
     *
     * @param _tokenId The token id.
     */
    function unwrapToSelf(uint256 _tokenId, address _exchangeToken, uint256 _verifierFee) external {
        unwrap(_tokenId);

        if (_verifierFee > 0) {
            IERC20(_exchangeToken).safeTransfer(BP_PRICE_DISCOVERY, _verifierFee);
        }

        Common._getFermionCommonStorage().exchangeToken = _exchangeToken;
    }

    /**
     * @notice Puts the F-NFT from wrapped to unverified state and transfers Boson rNFT to fermion protocol
     *
     * @param _tokenId The token id.
     */
    function unwrap(uint256 _tokenId) internal {
        Common.checkStateAndCaller(_tokenId, FermionTypes.TokenState.Wrapped, BP_PRICE_DISCOVERY);

        Common.changeTokenState(_tokenId, FermionTypes.TokenState.Unverified); // Moving to next state, also enabling the transfer and prevent reentrancy

        // transfer Boson Voucher to Fermion protocol. Not using safeTransferFrom since we are sure Fermion Protocol can handle the voucher
        IERC721(voucherAddress).transferFrom(address(this), fermionProtocol, _tokenId);
    }

    /**
     * @notice Prepares data to finalize the auction using Seaport
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function finalizeAuction(
        uint256 _tokenId,
        SeaportTypes.AdvancedOrder calldata _buyerOrder
    ) internal returns (uint256 reducedPrice, address exchangeToken) {
        address wrappedVoucherOwner = ownerOf(_tokenId); // tokenId can be taken from buyer order

        uint256 _price = _buyerOrder.parameters.offer[0].startAmount;
        if (_price == 0) {
            // Skip the call to seaport
            // This is possible only if verifier fee is 0, and nothing has to be encumbered by the Boson Protocol
            // Only transfer the wrapped NFT to the buyer. Signature is not verified, since no buyer's funds are moved
            // In practice, OpensSea will not allow this, since they do not allow 0 price auctions
            address buyer = _buyerOrder.parameters.offerer;
            _safeTransfer(wrappedVoucherOwner, buyer, _tokenId);
            return (0, address(0));
        }

        return finalizeOpenSeaAuction(_tokenId, _buyerOrder);
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
            Common.changeTokenState(tokenId, FermionTypes.TokenState.Wrapped);
        }
    }
}
