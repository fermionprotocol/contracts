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
     * - Any token in the corresponding offer is checked out
     * - The previous request is too recent
     * - The custodian fee period is 0
     *
     * @param _offerId The offer ID for which to request the custodian update
     * @param _newCustodianId The ID of the new custodian to take over
     * @param _newCustodianFee The new custodian fee parameters including amount and period
     * @param _newCustodianVaultParameters The new custodian vault parameters including minimum and maximum amounts
     */
    function requestCustodianUpdate(
        uint256 _offerId,
        uint256 _newCustodianId,
        FermionTypes.CustodianFee calldata _newCustodianFee,
        FermionTypes.CustodianVaultParameters calldata _newCustodianVaultParameters
    ) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        if (_newCustodianFee.period == 0) {
            revert InvalidCustodianFeePeriod();
        }

        FermionStorage.OfferLookups storage offerLookups = FermionStorage.protocolLookups().offerLookups[_offerId];

        // Check if there was a recent request
        if (offerLookups.custodianUpdateRequest.requestTimestamp + 1 days > block.timestamp) {
            revert UpdateRequestTooRecent(_offerId, 1 days);
        }

        uint256 currentCustodianId = FermionStorage.protocolEntities().offer[_offerId].custodianId;

        // Validate caller is the new custodian's assistant
        EntityLib.validateAccountRole(
            _newCustodianId,
            _msgSender(),
            FermionTypes.EntityRole.Custodian,
            FermionTypes.AccountRole.Assistant
        );

        _createCustodianUpdateRequest(
            _offerId,
            _newCustodianFee,
            _newCustodianVaultParameters,
            currentCustodianId,
            _newCustodianId,
            offerLookups
        );
    }

    /**
     * @notice Emergency update of custodian
     * @dev Allows the current custodian's assistant or seller's assistant to force a custodian update
     *
     * This is an emergency function that bypasses:
     * - The time restriction between updates
     * - The owner acceptance requirement
     * - The token status check (all checked-in tokens should be owned by the same owner)
     *
     * The current custodian is paid for the used period.
     * The vault parameters remain unchanged in emergency updates.
     *
     * Emits CustodianUpdateRequested and CustodianUpdateAccepted events
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the current custodian's assistant (if _isCustodianAssistant is true)
     * - Caller is not the seller's assistant (if _isCustodianAssistant is false)
     * - New custodian ID is invalid
     * - There are not enough funds in any vault to pay the current custodian
     *
     * @param _offerId The offer ID for which to update the custodian
     * @param _newCustodianId The ID of the new custodian
     * @param _isCustodianAssistant If true, validates caller as custodian assistant, otherwise as seller assistant
     */
    function emergencyCustodianUpdate(
        uint256 _offerId,
        uint256 _newCustodianId,
        bool _isCustodianAssistant
    ) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();
        FermionTypes.Offer storage offer = pe.offer[_offerId];
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.OfferLookups storage offerLookups = pl.offerLookups[_offerId];

        uint256 currentCustodianId = offer.custodianId;

        if (_isCustodianAssistant) {
            EntityLib.validateAccountRole(
                currentCustodianId,
                _msgSender(),
                FermionTypes.EntityRole.Custodian,
                FermionTypes.AccountRole.Assistant
            );
        } else {
            EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId);
        }

        EntityLib.validateEntityRole(
            _newCustodianId,
            pe.entityData[_newCustodianId].roles,
            FermionTypes.EntityRole.Custodian
        );

        _createCustodianUpdateRequest(
            _offerId,
            offer.custodianFee,
            offerLookups.custodianVaultParameters,
            currentCustodianId,
            _newCustodianId,
            offerLookups
        );

        _processCustodianUpdate(_offerId, offer, offerLookups.custodianUpdateRequest, offerLookups);
    }

    /**
     * @notice Accept a custodian update request
     * @dev Processes the acceptance of a custodian update request by the token owner
     *
     * The current custodian is paid for the used period.
     * The vault parameters are updated with the new custodian's parameters.
     * All items in the offer are updated and the current custodian is paid for each item.
     * Tokens that are checked out are skipped in ownership validation.
     *
     * Emits a CustodianUpdateAccepted event
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the owner of all in-custody tokens in the offer
     * - The update request status is not Requested
     * - The update request has expired
     * - There are not enough funds in any vault to pay the current custodian
     *
     * @param _offerId The offer ID for which to accept the custodian update
     */
    function acceptCustodianUpdate(
        uint256 _offerId
    ) external notPaused(FermionTypes.PausableRegion.Custody) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.OfferLookups storage offerLookups = pl.offerLookups[_offerId];
        FermionTypes.CustodianUpdateRequest storage updateRequest = offerLookups.custodianUpdateRequest;

        // Check request hasn't expired
        if (updateRequest.requestTimestamp + 1 days < block.timestamp) {
            revert UpdateRequestExpired(_offerId);
        }

        address fermionFNFTAddress = offerLookups.fermionFNFTAddress;
        address msgSender = _msgSender();
        uint256 itemCount = offerLookups.itemQuantity;
        uint256 firstTokenId = offerLookups.firstTokenId;
        bool hasInCustodyToken;
        for (uint256 i; i < itemCount; ++i) {
            uint256 tokenId = firstTokenId + i;
            if (pl.tokenLookups[tokenId].checkoutRequest.status != FermionTypes.CheckoutRequestStatus.CheckedOut) {
                address tokenOwner = IERC721(fermionFNFTAddress).ownerOf(tokenId);
                if (tokenOwner != msgSender) {
                    revert NotTokenBuyer(_offerId, tokenOwner, msgSender);
                }
                hasInCustodyToken = true;
            }
        }
        if (!hasInCustodyToken) {
            revert NoTokensInCustody(_offerId);
        }
        _processCustodianUpdate(
            _offerId,
            FermionStorage.protocolEntities().offer[_offerId],
            updateRequest,
            offerLookups
        );
    }

    /**
     * @notice Creates a custodian update request
     * @dev Internal helper function to create and store a custodian update request
     *
     * @param _offerId The offer ID for which to create the update request
     * @param _custodianFee The new custodian fee parameters
     * @param _custodianVaultParameters The new custodian vault parameters
     * @param _currentCustodianId The ID of the current custodian
     * @param _newCustodianId The ID of the new custodian
     * @param _offerLookups The offer lookups storage pointer
     */
    function _createCustodianUpdateRequest(
        uint256 _offerId,
        FermionTypes.CustodianFee memory _custodianFee,
        FermionTypes.CustodianVaultParameters memory _custodianVaultParameters,
        uint256 _currentCustodianId,
        uint256 _newCustodianId,
        FermionStorage.OfferLookups storage _offerLookups
    ) internal {
        _offerLookups.custodianUpdateRequest = FermionTypes.CustodianUpdateRequest({
            newCustodianId: _newCustodianId,
            custodianFee: _custodianFee,
            custodianVaultParameters: _custodianVaultParameters,
            requestTimestamp: block.timestamp
        });

        emit CustodianUpdateRequested(
            _offerId,
            _currentCustodianId,
            _newCustodianId,
            _custodianFee,
            _custodianVaultParameters
        );
    }

    /**
     * @notice Process custodian update
     * @dev Internal helper function to process the custodian update for the offer.
     * Calculates and pays the current custodian, updates the vault period for each token.
     * Also updates the vault parameters for the new custodian in the offer.
     *
     * Reverts if:
     * - Any token within the offer is checked out
     * - There are not enough funds in the vault to pay the current custodian
     *
     * @param _offerId The offer ID for which to process the update
     * @param _offer The offer storage pointer
     * @param _updateRequest The update request storage pointer
     * @param _offerLookups The offer lookups storage pointer
     */
    function _processCustodianUpdate(
        uint256 _offerId,
        FermionTypes.Offer storage _offer,
        FermionTypes.CustodianUpdateRequest storage _updateRequest,
        FermionStorage.OfferLookups storage _offerLookups
    ) internal {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();

        uint256 currentCustodianId = _offer.custodianId;
        uint256 currentCustodianFee = _offer.custodianFee.amount;
        uint256 currentCustodianPeriod = _offer.custodianFee.period;

        uint256 itemCount = _offerLookups.itemQuantity;
        uint256 firstTokenId = _offerLookups.firstTokenId;

        // payout the current custodian
        for (uint256 i; i < itemCount; ++i) {
            uint256 tokenId = firstTokenId + i;
            FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[tokenId];
            if (tokenLookups.checkoutRequest.status == FermionTypes.CheckoutRequestStatus.CheckedOut) {
                continue;
            }
            // Calculate and pay the current custodian
            FermionTypes.CustodianFee storage vault = tokenLookups.vault;
            uint256 custodianPayoff = ((block.timestamp - vault.period) * currentCustodianFee) / currentCustodianPeriod;

            if (custodianPayoff > vault.amount) {
                revert InsufficientVaultBalance(tokenId, custodianPayoff, vault.amount);
            }

            increaseAvailableFunds(currentCustodianId, _offer.exchangeToken, custodianPayoff);
            vault.amount -= custodianPayoff;

            // Reset the vault period
            vault.period = block.timestamp;
        }

        FermionTypes.CustodianVaultParameters memory custodianVaultParameters = _updateRequest.custodianVaultParameters;
        FermionTypes.CustodianFee memory custodianFee = _updateRequest.custodianFee;
        uint256 newCustodianId = _updateRequest.newCustodianId;

        _offer.custodianId = newCustodianId;
        _offer.custodianFee = custodianFee;
        _offerLookups.custodianVaultParameters = custodianVaultParameters;

        delete _offerLookups.custodianUpdateRequest;

        emit CustodianUpdateAccepted(
            _offerId,
            currentCustodianId,
            newCustodianId,
            custodianFee,
            custodianVaultParameters
        );
    }
}
