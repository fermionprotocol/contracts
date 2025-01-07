// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { CustodyErrors, FermionGeneralErrors } from "../domain/Errors.sol";
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
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

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

        pl.tokenLookups[_tokenId].phygitalsRecipient = EntityLib.getOrCreateBuyerId(buyer, pl);

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

    /**
     * @notice Request a custodian update
     *
     * The new custodian initiates the update process by calling this function.
     * The request is valid for 24 hours.
     * A new request can be made only after 24 hours from the previous request.
     *
     * Emits a CustodianUpdateRequested event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the new custodian's assistant
     * - The token is checked out
     * - The previous request is too recent
     * - For multi-item offers, any item is checked out
     *
     * @param _tokenId - the token ID
     * @param _newCustodianFee - the new custodian fee, ignored if keepExistingParameters is true
     * @param _keepExistingParameters - if true, keep the current custodian fee
     */
    function requestCustodianUpdate(
        uint256 _tokenId,
        FermionTypes.CustodianFee calldata _newCustodianFee,
        bool _keepExistingParameters
    ) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenId];

        // Check if there was a recent request
        if (tokenLookups.custodianUpdateRequest.requestTimestamp + 1 days > block.timestamp) {
            revert UpdateRequestTooRecent(_tokenId, 1 days);
        }

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 currentCustodianId = offer.custodianId;

        // For multi-item offers, check that no item is checked out
        FermionStorage.OfferLookups storage offerLookups = pl.offerLookups[offerId];
        uint256 itemCount = offerLookups.custodianVaultItems;
        if (itemCount > 1) {
            uint256 firstTokenId = _tokenId & ~uint256(0xFFFFFFFFFFFFFFFF); // Clear lower 64 bits
            for (uint256 i; i < itemCount; ) {
                uint256 tokenId = firstTokenId + i;
                if (pl.tokenLookups[tokenId].checkoutRequest.status == FermionTypes.CheckoutRequestStatus.CheckedOut) {
                    revert TokenCheckedOut(tokenId);
                }
                unchecked {
                    ++i;
                }
            }
        } else {
            // Single item - check just this token
            if (tokenLookups.checkoutRequest.status == FermionTypes.CheckoutRequestStatus.CheckedOut) {
                revert TokenCheckedOut(_tokenId);
            }
        }

        _createCustodianUpdateRequest(
            _tokenId,
            _newCustodianFee,
            _keepExistingParameters,
            currentCustodianId,
            offer,
            tokenLookups,
            pl
        );
    }

    function _createCustodianUpdateRequest(
        uint256 _tokenId,
        FermionTypes.CustodianFee calldata _newCustodianFee,
        bool _keepExistingParameters,
        uint256 _currentCustodianId,
        FermionTypes.Offer storage _offer,
        FermionStorage.TokenLookups storage _tokenLookups,
        FermionStorage.ProtocolLookups storage _pl
    ) internal {
        // Check the caller is the new custodian's assistant
        address msgSender = _msgSender();
        uint256 newCustodianId = EntityLib.getOrCreateBuyerId(msgSender, _pl);
        EntityLib.validateAccountRole(
            newCustodianId,
            msgSender,
            FermionTypes.EntityRole.Custodian,
            FermionTypes.AccountRole.Assistant
        );

        // Store the update request
        _tokenLookups.custodianUpdateRequest = FermionTypes.CustodianUpdateRequest({
            status: FermionTypes.CustodianUpdateStatus.Requested,
            newCustodianId: newCustodianId,
            newCustodianFee: _keepExistingParameters
                ? FermionTypes.CustodianFee({ amount: _offer.custodianFee.amount, period: _offer.custodianFee.period })
                : _newCustodianFee,
            requestTimestamp: block.timestamp,
            keepExistingParameters: _keepExistingParameters,
            isEmergencyUpdate: false
        });

        emit CustodianUpdateRequested(_tokenId, _currentCustodianId, newCustodianId, _newCustodianFee);
    }

    /**
     * @notice Request an emergency custodian update
     *
     * The current custodian or seller can initiate an emergency update when the custodian stops operating.
     * This bypasses the owner acceptance and keeps the existing fee parameters.
     *
     * Emits a CustodianUpdateRequested event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the current custodian's assistant or seller's assistant
     * - The token is checked out
     * - The previous request is too recent
     * - For multi-item offers, any item is checked out
     *
     * @param _tokenId - the token ID
     * @param _newCustodianId - the ID of the new custodian
     * @param _isCustodianAssistant - if true, validate caller as custodian assistant, otherwise as seller assistant
     */
    function requestEmergencyCustodianUpdate(
        uint256 _tokenId,
        uint256 _newCustodianId,
        bool _isCustodianAssistant
    ) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenId];

        // Check if there was a recent request
        if (tokenLookups.custodianUpdateRequest.requestTimestamp + 1 days > block.timestamp) {
            revert UpdateRequestTooRecent(_tokenId, 1 days);
        }

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 currentCustodianId = offer.custodianId;

        // For multi-item offers, check that no item is checked out
        FermionStorage.OfferLookups storage offerLookups = pl.offerLookups[offerId];
        uint256 itemCount = offerLookups.custodianVaultItems;
        if (itemCount > 1) {
            uint256 firstTokenId = _tokenId & ~uint256(0xFFFFFFFFFFFFFFFF); // Clear lower 64 bits
            for (uint256 i; i < itemCount; ) {
                uint256 tokenId = firstTokenId + i;
                if (pl.tokenLookups[tokenId].checkoutRequest.status == FermionTypes.CheckoutRequestStatus.CheckedOut) {
                    revert TokenCheckedOut(tokenId);
                }
                unchecked {
                    ++i;
                }
            }
        } else {
            // Single item - check just this token
            if (tokenLookups.checkoutRequest.status == FermionTypes.CheckoutRequestStatus.CheckedOut) {
                revert TokenCheckedOut(_tokenId);
            }
        }

        // Check the caller is either the current custodian's assistant or seller's assistant
        address msgSender = _msgSender();
        if (_isCustodianAssistant) {
            EntityLib.validateAccountRole(
                currentCustodianId,
                msgSender,
                FermionTypes.EntityRole.Custodian,
                FermionTypes.AccountRole.Assistant
            );
        } else {
            EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId);
        }

        // Validate that the new custodian exists and has the Custodian role
        EntityLib.validateEntityRole(
            _newCustodianId,
            FermionStorage.protocolEntities().entityData[_newCustodianId].roles,
            FermionTypes.EntityRole.Custodian
        );

        // Store the update request - keep existing parameters in emergency update
        tokenLookups.custodianUpdateRequest = FermionTypes.CustodianUpdateRequest({
            status: FermionTypes.CustodianUpdateStatus.Requested,
            newCustodianId: _newCustodianId,
            newCustodianFee: offer.custodianFee,
            requestTimestamp: block.timestamp,
            keepExistingParameters: true,
            isEmergencyUpdate: true
        });

        emit CustodianUpdateRequested(_tokenId, currentCustodianId, _newCustodianId, offer.custodianFee);
    }

    /**
     * @notice Accept a custodian update request
     *
     * The FNFT owner accepts the update request.
     * The current custodian is paid for the used period.
     * The vault parameters are updated with the new custodian's parameters.
     * For multi-item offers, all items are updated and the current custodian is paid for each item.
     *
     * Emits a CustodianUpdateAccepted event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the owner of the token (unless it's an emergency update)
     * - The token is checked out
     * - The update request status is not Requested
     * - The update request has expired
     * - There are not enough funds in any vault to pay the current custodian
     *
     * @param _tokenId - the token ID
     */
    function acceptCustodianUpdate(
        uint256 _tokenId
    ) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenId];

        // Validate update request status
        FermionTypes.CustodianUpdateRequest storage updateRequest = tokenLookups.custodianUpdateRequest;
        if (updateRequest.status != FermionTypes.CustodianUpdateStatus.Requested) {
            revert InvalidCustodianUpdateStatus(
                _tokenId,
                FermionTypes.CustodianUpdateStatus.Requested,
                updateRequest.status
            );
        }

        // Check request hasn't expired
        if (updateRequest.requestTimestamp + 1 days < block.timestamp) {
            revert UpdateRequestExpired(_tokenId);
        }

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 oldCustodianId = offer.custodianId;

        // For non-emergency updates, check the caller owns the token
        if (!updateRequest.isEmergencyUpdate) {
            address msgSender = _msgSender();
            address owner = IERC721(pl.offerLookups[offerId].fermionFNFTAddress).ownerOf(_tokenId);
            if (owner != msgSender) {
                revert NotTokenBuyer(_tokenId, owner, msgSender);
            }
        }

        // For multi-item offers, process all items
        FermionStorage.OfferLookups storage offerLookups = pl.offerLookups[offerId];
        uint256 itemCount = offerLookups.custodianVaultItems;
        if (itemCount > 1) {
            uint256 firstTokenId = _tokenId & ~uint256(0xFFFFFFFFFFFFFFFF); // Clear lower 64 bits
            for (uint256 i; i < itemCount; ) {
                uint256 tokenId = firstTokenId + i;
                _processCustodianUpdate(tokenId, oldCustodianId, offer, updateRequest);
                unchecked {
                    ++i;
                }
            }
        } else {
            _processCustodianUpdate(_tokenId, oldCustodianId, offer, updateRequest);
        }

        offer.custodianId = updateRequest.newCustodianId;
        if (!updateRequest.keepExistingParameters) {
            offer.custodianFee = updateRequest.newCustodianFee;
        }

        uint256 newCustodianId = updateRequest.newCustodianId;
        delete tokenLookups.custodianUpdateRequest;

        emit CustodianUpdateAccepted(_tokenId, oldCustodianId, newCustodianId);
    }

    /**
     * @notice Process custodian update for a single token
     *
     * Internal helper function to process the custodian update for a single token.
     * Calculates and pays the current custodian, updates the vault period.
     *
     * Reverts if:
     * - The token is checked out
     * - There are not enough funds in the vault to pay the current custodian
     *
     * @param _tokenId - the token ID
     * @param _oldCustodianId - the ID of the current custodian
     * @param _offer - the offer storage pointer
     * @param _updateRequest - the update request storage pointer
     */
    function _processCustodianUpdate(
        uint256 _tokenId,
        uint256 _oldCustodianId,
        FermionTypes.Offer storage _offer,
        FermionTypes.CustodianUpdateRequest storage _updateRequest
    ) internal {
        FermionStorage.TokenLookups storage tokenLookups = FermionStorage.protocolLookups().tokenLookups[_tokenId];

        if (tokenLookups.checkoutRequest.status == FermionTypes.CheckoutRequestStatus.CheckedOut) {
            revert TokenCheckedOut(_tokenId);
        }

        // Calculate and pay the current custodian
        FermionTypes.CustodianFee storage vault = tokenLookups.vault;
        uint256 lastReleased = vault.period;
        uint256 custodianFee = _offer.custodianFee.amount;
        uint256 custodianPeriod = _offer.custodianFee.period;
        uint256 custodianPayoff = ((block.timestamp - lastReleased) * custodianFee) / custodianPeriod;

        if (custodianPayoff > vault.amount) {
            revert InsufficientVaultBalance(_tokenId, custodianPayoff, vault.amount);
        }

        // Pay the current custodian
        increaseAvailableFunds(_oldCustodianId, _offer.exchangeToken, custodianPayoff);
        vault.amount -= custodianPayoff;

        // Reset the vault period
        vault.period = block.timestamp;
    }

    /**
     * @notice Reject a custodian update request
     *
     * The FNFT owner rejects the update request.
     * For emergency updates, this function cannot be called.
     *
     * Emits a CustodianUpdateRejected event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the owner of the token
     * - The update request status is not Requested
     * - The update request has expired
     * - The update is an emergency update
     *
     * @param _tokenId - the token ID
     */
    function rejectCustodianUpdate(
        uint256 _tokenId
    ) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenId];

        // Validate update request status
        FermionTypes.CustodianUpdateRequest storage updateRequest = tokenLookups.custodianUpdateRequest;
        if (updateRequest.status != FermionTypes.CustodianUpdateStatus.Requested) {
            revert InvalidCustodianUpdateStatus(
                _tokenId,
                FermionTypes.CustodianUpdateStatus.Requested,
                updateRequest.status
            );
        }

        if (updateRequest.requestTimestamp + 1 days < block.timestamp) {
            revert UpdateRequestExpired(_tokenId);
        }

        address msgSender = _msgSender();

        if (updateRequest.isEmergencyUpdate) {
            revert FermionGeneralErrors.AccessDenied(msgSender);
        }

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        address owner = IERC721(pl.offerLookups[offerId].fermionFNFTAddress).ownerOf(_tokenId);
        if (owner != msgSender) {
            revert NotTokenBuyer(_tokenId, owner, msgSender);
        }

        delete tokenLookups.custodianUpdateRequest;

        emit CustodianUpdateRejected(_tokenId, offer.custodianId, updateRequest.newCustodianId);
    }
}
