// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { CustodyErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { CustodyLib } from "../libs/CustodyLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { Context } from "../libs/Context.sol";
import { ICustodyEvents } from "../interfaces/events/ICustodyEvents.sol";
import { IFundsEvents } from "../interfaces/events/IFundsEvents.sol";
import { FermionFNFTLib } from "../libs/FermionFNFTLib.sol";

/**
 * @title CustodyFacet
 *
 * @notice Handles RWA custody.
 */
contract CustodyFacet is Context, CustodyErrors, Access, CustodyLib, ICustodyEvents, IFundsEvents {
    using FermionFNFTLib for address;

    constructor(bytes32 _fnftCodeHash) FundsLib(_fnftCodeHash) {}

    /**
     * @notice Notifies the protocol that an RWA has been checked in
     *
     * Emits an CheckedIn event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the custodian's assistant
     * - The token is not in the Verified state
     * - The checkout request status is not None
     *
     * @param _tokenId - the token ID
     */
    function checkIn(uint256 _tokenId) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.None,
            pl
        );

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 custodianId = offer.custodianId;

        // Check the caller is the custodian's assistant
        EntityLib.validateAccountRole(
            custodianId,
            _msgSender(),
            FermionTypes.EntityRole.Custodian,
            FermionTypes.AccountRole.Assistant
        );

        pl.offerLookups[offerId].fermionFNFTAddress.pushToNextTokenState(_tokenId, FermionTypes.TokenState.CheckedIn);

        checkoutRequest.status = FermionTypes.CheckoutRequestStatus.CheckedIn;

        setupCustodianItemVault(_tokenId, block.timestamp);

        emit CheckedIn(custodianId, _tokenId);
    }

    /**
     * @notice Notifies the protocol that an RWA has been checked out
     *
     * Emits an CheckedOut event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the custodian's assistant
     * - The checkout request status is not CheckOutRequestCleared
     *
     * @param _tokenId - the token ID
     */
    function checkOut(uint256 _tokenId) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.CheckOutRequestCleared,
            pl
        );

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 custodianId = offer.custodianId;

        // Check the caller is the verifier's assistant
        EntityLib.validateAccountRole(
            custodianId,
            _msgSender(),
            FermionTypes.EntityRole.Custodian,
            FermionTypes.AccountRole.Assistant
        );

        closeCustodianItemVault(_tokenId, custodianId, offer.exchangeToken);

        checkoutRequest.status = FermionTypes.CheckoutRequestStatus.CheckedOut;
        emit CheckedOut(custodianId, _tokenId);

        pl.offerLookups[offerId].fermionFNFTAddress.pushToNextTokenState(_tokenId, FermionTypes.TokenState.CheckedOut);
    }

    /**
     * @notice Request a checkout
     *
     * Emits an CheckoutRequested event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the owner of the token
     * - The checkout request status is not CheckedIn
     *
     * @param _tokenId - the token ID
     */
    function requestCheckOut(uint256 _tokenId) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.CheckedIn,
            pl
        );

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        address msgSender = _msgSender();
        pl.offerLookups[offerId].fermionFNFTAddress.transferFrom(msgSender, address(this), _tokenId);

        checkoutRequest.status = FermionTypes.CheckoutRequestStatus.CheckOutRequested;
        checkoutRequest.buyer = msgSender;

        emit CheckoutRequested(offer.custodianId, _tokenId, offer.sellerId, msgSender);
    }

    /**
     * @notice Submit tax amount
     *
     * After the buyer has requested a checkout, the seller's assistant calls this function to submit the tax amount.
     * If there are no taxes to be paid, the seller's assistant calls the finalizeCheckout function without calling this function.
     *
     * Emits an TaxAmountSubmitted event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the seller's assistant or facilitator
     * - The checkout request status is not CheckOutRequested
     * - The submitted tax amount is zero
     *
     * @param _tokenId - the token ID
     * @param _taxAmount - the tax amount
     */
    function submitTaxAmount(
        uint256 _tokenId,
        uint256 _taxAmount
    ) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.CheckOutRequested,
            FermionStorage.protocolLookups()
        );

        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        uint256 sellerId = offer.sellerId;
        EntityLib.validateSellerAssistantOrFacilitator(sellerId, offer.facilitatorId);

        if (_taxAmount == 0) revert InvalidTaxAmount();
        checkoutRequest.taxAmount = _taxAmount;

        emit TaxAmountSubmitted(_tokenId, sellerId, _taxAmount);
    }

    /**
     * @notice Clear the checkout request
     *
     * If there are not outstanding taxes to be paid, the seller calls this function to finalize the checkout.
     * If there are taxes to be paid, the buyer calls this function to finalize the checkout.
     *
     * Emits an CheckOutRequestCleared event
     *
     * Reverts if:
     * - Custody region is paused
     * - If no taxes are to be paid and:
     *   - The caller is not the seller's assistant or facilitator
     * - if taxes are to be paid and:
     *   - the caller is not the buyer
     *   - the amount paid is less than the amount owed
     * - The checkout request status is not CheckOutRequested
     *
     * @param _tokenId - the token ID
     */
    function clearCheckoutRequest(
        uint256 _tokenId
    ) external payable notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.CheckOutRequested,
            pl
        );

        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        uint256 taxAmount = checkoutRequest.taxAmount;
        address buyer = checkoutRequest.buyer;
        if (taxAmount == 0) {
            // Seller is finalizing the checkout
            EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId);
        } else {
            // Buyer is finalizing the checkout
            address msgSender = _msgSender();
            if (buyer != msgSender) {
                revert NotTokenBuyer(_tokenId, buyer, msgSender);
            }

            address exchangeToken = offer.exchangeToken;
            validateIncomingPayment(exchangeToken, taxAmount);
            increaseAvailableFunds(offer.sellerId, exchangeToken, taxAmount);
        }

        checkoutRequest.status = FermionTypes.CheckoutRequestStatus.CheckOutRequestCleared;

        pl.tokenLookups[_tokenId].phygitalsRecipient = EntityLib.getOrCreateEntityId(
            buyer,
            FermionTypes.EntityRole.Buyer,
            pl
        );

        emit CheckOutRequestCleared(offer.custodianId, _tokenId);
    }

    /**
     * @notice Gets tax amount
     *
     * @param _tokenId - the token ID
     */
    function getTaxAmount(uint256 _tokenId) external view returns (uint256) {
        return FermionStorage.protocolLookups().tokenLookups[_tokenId].checkoutRequest.taxAmount;
    }

    /**
     * @notice Get a valid checkout request
     *
     * Reverts if:
     * - The checkout request status is not the expected status
     *
     * @param _tokenId - the token ID
     * @param _expectedStatus - the expected status
     * @param pl - the protocol lookups storage
     */
    function getValidCheckoutRequest(
        uint256 _tokenId,
        FermionTypes.CheckoutRequestStatus _expectedStatus,
        FermionStorage.ProtocolLookups storage pl
    ) internal view returns (FermionTypes.CheckoutRequest storage) {
        FermionTypes.CheckoutRequest storage checkoutRequest = pl.tokenLookups[_tokenId].checkoutRequest;

        if (checkoutRequest.status != _expectedStatus)
            revert InvalidCheckoutRequestStatus(_tokenId, _expectedStatus, checkoutRequest.status);

        return checkoutRequest;
    }
}
