// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { HUNDRED_PERCENT } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionGeneralErrors, WrapperErrors } from "../domain/Errors.sol";
import { Common, InvalidStateOrCaller } from "./Common.sol";
import { SeaportWrapper } from "./SeaportWrapper.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { IFermionWrapperEvents } from "../interfaces/events/IFermionWrapperEvents.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { CreatorToken, ITransferValidator721 } from "./CreatorToken.sol";
import { RoyaltiesFacet } from "../facets/Royalties.sol";
import { VerificationFacet } from "../facets/Verification.sol";

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
contract FermionWrapper is FermionFNFTBase, Ownable, CreatorToken, IFermionWrapper, IFermionWrapperEvents {
    using SafeERC20 for IERC20;
    using Address for address;
    IWrappedNative private immutable WRAPPED_NATIVE;
    address private immutable SEAPORT_WRAPPER;
    address private immutable STRICT_AUTHORIZED_TRANSFER_SECURITY_REGISTRY;

    /**
     * @notice Constructor
     *
     */
    constructor(
        address _bosonPriceDiscovery,
        address _seaportWrapper,
        address _strictAuthorizedTransferSecurityRegistry,
        address _wrappedNative
    ) FermionFNFTBase(_bosonPriceDiscovery) {
        if (_wrappedNative == address(0)) revert FermionGeneralErrors.InvalidAddress();
        WRAPPED_NATIVE = IWrappedNative(_wrappedNative);
        SEAPORT_WRAPPER = _seaportWrapper;
        STRICT_AUTHORIZED_TRANSFER_SECURITY_REGISTRY = _strictAuthorizedTransferSecurityRegistry;
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
        if (STRICT_AUTHORIZED_TRANSFER_SECURITY_REGISTRY != address(0))
            _setTransferValidator(STRICT_AUTHORIZED_TRANSFER_SECURITY_REGISTRY);
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
    function wrap(uint256 _firstTokenId, uint256 _length, address _to) external {
        address msgSender = _msgSender();
        for (uint256 i; i < _length; ++i) {
            uint256 tokenId = _firstTokenId + i;

            // Not using safeTransferFrom since this contract is the recipient and we are sure it can handle the vouchers
            IERC721(voucherAddress).transferFrom(msgSender, address(this), tokenId);

            // Mint to the specified address
            if (_to == address(this)) {
                _mint(_to, tokenId);
            } else {
                _safeMint(_to, tokenId);
            }
        }
    }

    /**
     * @notice List fixed order on Seaport
     *
     * Reverts if:
     * - lengths of _tokenIds, _prices and _endTimes do not match
     *
     * @param _firstTokenId The first token id.
     * @param _prices The prices for each token.
     * @param _endTimes The end times for each token.
     * @param _royaltyInfo The royalty info.
     * @param _exchangeToken The token to be used for the exchange.
     */
    function listFixedPriceOrders(
        uint256 _firstTokenId,
        uint256[] calldata _prices,
        uint256[] calldata _endTimes,
        FermionTypes.RoyaltyInfo calldata _royaltyInfo,
        address _exchangeToken
    ) external {
        Common.checkStateAndCaller(_firstTokenId, FermionTypes.TokenState.Wrapped, _msgSender(), fermionProtocol);

        SEAPORT_WRAPPER.functionDelegateCall(
            abi.encodeCall(
                SeaportWrapper.listFixedPriceOrders,
                (_firstTokenId, _prices, _endTimes, _royaltyInfo, _exchangeToken)
            )
        );
    }

    /**
     * @notice Cancel fixed price orders on OpenSea.
     *
     * Reverts if:
     * - The token id does not exist.
     * - The token id does not match the order.
     * - The order's token does not match the contract.
     *
     * @param _orders The orders to cancel.
     */
    function cancelFixedPriceOrders(SeaportTypes.OrderComponents[] calldata _orders) external {
        if (fermionProtocol != _msgSender()) {
            revert FermionGeneralErrors.AccessDenied(_msgSender());
        }

        SEAPORT_WRAPPER.functionDelegateCall(abi.encodeCall(SeaportWrapper.cancelFixedPriceOrders, (_orders)));
    }

    /**
     * @notice Unwraps the voucher, finalizes the auction, transfers the Boson rNFT to Fermion Protocol and F-NFT to the buyer
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function unwrap(uint256 _tokenId, SeaportTypes.AdvancedOrder calldata _buyerOrder) external {
        if (Common._getFermionCommonStorage().fixedPrice[_tokenId] > 0 && ownerOf(_tokenId) != address(this))
            revert WrapperErrors.InvalidUnwrap();
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
     * @notice Unwraps the voucher, and transfers the sale proceeds to Boson Protocol
     *
     * @param _tokenId The token id.
     * @param _exchangeToken The token to be used for the exchange.
     */
    function unwrapFixedPriced(uint256 _tokenId, address _exchangeToken) external {
        if (ownerOf(_tokenId) == address(this)) revert WrapperErrors.InvalidOwner(_tokenId, address(0), address(this)); // Zero address means the expected value is anything but the actual value

        unwrapNFTAndTransferFundsToBosonPriceDiscoveryClient(
            _tokenId,
            _exchangeToken,
            Common._getFermionCommonStorage().fixedPrice[_tokenId]
        );
    }

    /**
     * @notice Unwraps the voucher, but skip the OS auction and leave the F-NFT with the seller
     *
     * @param _tokenId The token id.
     * @param _exchangeToken The token to be used for the exchange.
     * @param _verifierFee The verifier fee
     */
    function unwrapToSelf(uint256 _tokenId, address _exchangeToken, uint256 _verifierFee) external {
        if (Common._getFermionCommonStorage().fixedPrice[_tokenId] > 0 && ownerOf(_tokenId) != address(this))
            revert WrapperErrors.InvalidUnwrap();
        unwrapNFTAndTransferFundsToBosonPriceDiscoveryClient(_tokenId, _exchangeToken, _verifierFee);
    }

    /**
     * @dev See {IERC721Metadata-tokenURI}.
     */
    function tokenURI(uint256 _tokenId) public view virtual override returns (string memory) {
        _requireOwned(_tokenId);

        string memory revisedMetadata = VerificationFacet(fermionProtocol).getRevisedMetadata(_tokenId);
        if (bytes(revisedMetadata).length > 0) {
            return revisedMetadata;
        }

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
     * @notice Provides royalty info. (EIP-2981)
     * Called with the sale price to determine how much royalty is owed and to whom.
     *
     * @param _tokenId - the voucher queried for royalty information
     * @param _salePrice - the sale price of the voucher specified by _tokenId
     *
     * @return receiver - address of who should be sent the royalty payment
     * @return royaltyAmount - the royalty payment amount for the given sale price
     */
    function royaltyInfo(
        uint256 _tokenId,
        uint256 _salePrice
    ) external view returns (address receiver, uint256 royaltyAmount) {
        _requireOwned(_tokenId);

        uint256 royaltyPercentage;
        (receiver, royaltyPercentage) = RoyaltiesFacet(fermionProtocol).getEIP2981Royalties(_tokenId);

        royaltyAmount = (_salePrice * royaltyPercentage) / HUNDRED_PERCENT;
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
     * @notice If the seller owns the wrapped vouchers, they can be transferred to the first only during unwrapping.
     * If this contract owns the wrapped vouchers, they can be transferred only once to the first buyer.
     * The first buyer can transfer them only after they are verified.
     *
     * @param _to The address to transfer the wrapped tokens to.
     * @param _tokenId The token id.
     * @param _auth The address that is allowed to transfer the token.
     */
    function _update(address _to, uint256 _tokenId, address _auth) internal virtual override returns (address) {
        FermionTypes.TokenState state = Common._getFermionCommonStorage().tokenState[_tokenId];
        address msgSender = _msgSender();

        if (
            (state == FermionTypes.TokenState.Wrapped && !isFixedPriceSale(_tokenId)) ||
            (state == FermionTypes.TokenState.Unverified && _to != address(0))
        ) {
            revert InvalidStateOrCaller(_tokenId, msgSender, state);
        }

        address from = super._update(_to, _tokenId, _auth);
        if (from != msgSender && msgSender != fermionProtocol) {
            // Call the transfer validator if one is set.
            // If transfer is initiated by the protocol, no need to call the validator (mint/burn/checkout)
            address transferValidator = Common._getFermionCommonStorage().transferValidator;
            if (transferValidator != address(0)) {
                ITransferValidator721(transferValidator).validateTransfer(msgSender, from, _to, _tokenId);
            }
        }
        return from;
    }

    /**
     * @notice Detects if the transferred token belongs to fixed price offer
     *
     * Emits FixedPriceSale event if the token is part of a fixed price sale.
     *
     * @param _tokenId The token id.
     * @return isFixedPrice True if the token is part of a fixed price sale
     */
    function isFixedPriceSale(uint256 _tokenId) internal returns (bool isFixedPrice) {
        isFixedPrice =
            (ownerOf(_tokenId) == address(this)) &&
            (Common._getFermionCommonStorage().fixedPrice[_tokenId] > 0);

        if (isFixedPrice) {
            emit FixedPriceSale(_tokenId);
        }

        return isFixedPrice;
    }

    /**
     * @notice Unwraps the voucher and transfers the funds to Boson Protocol price discovery client.
     * This is used for the unwraps, where the funds are not already transferred to the Boson protocol
     *
     * @param _tokenId The token id.
     * @param _exchangeToken The token to be used for the exchange.
     * @param _value The amount to transfer
     */
    function unwrapNFTAndTransferFundsToBosonPriceDiscoveryClient(
        uint256 _tokenId,
        address _exchangeToken,
        uint256 _value
    ) internal {
        unwrap(_tokenId);

        Common.changeTokenState(_tokenId, FermionTypes.TokenState.Unverified); // Move to the next state

        if (_value > 0) {
            if (_exchangeToken == address(0)) {
                WRAPPED_NATIVE.deposit{ value: _value }();
                _exchangeToken = address(WRAPPED_NATIVE);
            }

            IERC20(_exchangeToken).safeTransfer(BP_PRICE_DISCOVERY, _value);
        }
    }

    receive() external payable {}
}
