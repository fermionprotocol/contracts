// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { ICustodyEvents } from "../interfaces/events/ICustodyEvents.sol";
import { IFundsEvents } from "../interfaces/events/IFundsEvents.sol";

/**
 * @title CustodyFacet
 *
 * @notice Handles RWA custody.
 */
contract CustodyFacet is Context, FermionErrors, Access, ICustodyEvents, IFundsEvents {
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
    function checkIn(uint256 _tokenId) external notPaused(FermionTypes.PausableRegion.Custody) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.None,
            pl
        );

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 custodianId = offer.custodianId;

        // Check the caller is the custodian's assistant
        EntityLib.validateWalletRole(
            custodianId,
            msgSender(),
            FermionTypes.EntityRole.Custodian,
            FermionTypes.WalletRole.Assistant
        );

        IFermionFNFT(pl.wrapperAddress[offerId]).pushToNextTokenState(_tokenId, FermionTypes.TokenState.CheckedIn);

        checkoutRequest.status = FermionTypes.CheckoutRequestStatus.CheckedIn;

        setupCustodianItemVault(_tokenId, offer.custodianFee);

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
    function checkOut(uint256 _tokenId) external notPaused(FermionTypes.PausableRegion.Custody) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.CheckOutRequestCleared,
            pl
        );

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 custodianId = offer.custodianId;

        // Check the caller is the verifier's assistant
        EntityLib.validateWalletRole(
            custodianId,
            msgSender(),
            FermionTypes.EntityRole.Custodian,
            FermionTypes.WalletRole.Assistant
        );

        closeCustodianItemVault(_tokenId, custodianId, offer.exchangeToken);

        checkoutRequest.status = FermionTypes.CheckoutRequestStatus.CheckedOut;
        emit CheckedOut(custodianId, _tokenId);

        IFermionFNFT(pl.wrapperAddress[offerId]).pushToNextTokenState(_tokenId, FermionTypes.TokenState.CheckedOut);
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
    function requestCheckOut(uint256 _tokenId) external notPaused(FermionTypes.PausableRegion.Custody) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.CheckedIn,
            pl
        );

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        address msgSender = msgSender();
        IFermionFNFT(pl.wrapperAddress[offerId]).transferFrom(msgSender, address(this), _tokenId);

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
    ) external notPaused(FermionTypes.PausableRegion.Custody) {
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
    function clearCheckoutRequest(uint256 _tokenId) external payable notPaused(FermionTypes.PausableRegion.Custody) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CheckoutRequest storage checkoutRequest = getValidCheckoutRequest(
            _tokenId,
            FermionTypes.CheckoutRequestStatus.CheckOutRequested,
            pl
        );

        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        uint256 taxAmount = checkoutRequest.taxAmount;
        if (taxAmount == 0) {
            // Seller is finalizing the checkout
            EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId);
        } else {
            // Buyer is finalizing the checkout
            address buyer = checkoutRequest.buyer;
            address msgSender = msgSender();
            if (buyer != msgSender) {
                revert NotTokenBuyer(_tokenId, buyer, msgSender);
            }

            address exchangeToken = offer.exchangeToken;
            FundsLib.validateIncomingPayment(exchangeToken, taxAmount);
            FundsLib.increaseAvailableFunds(offer.sellerId, exchangeToken, taxAmount);
        }

        checkoutRequest.status = FermionTypes.CheckoutRequestStatus.CheckOutRequestCleared;

        emit CheckOutRequestCleared(offer.custodianId, _tokenId);
    }

    /**
     * @notice Gets tax amount
     *
     * @param _tokenId - the token ID
     */
    function getTaxAmount(uint256 _tokenId) external view returns (uint256) {
        return FermionStorage.protocolLookups().checkoutRequest[_tokenId].taxAmount;
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
        FermionTypes.CheckoutRequest storage checkoutRequest = pl.checkoutRequest[_tokenId];

        if (checkoutRequest.status != _expectedStatus)
            revert InvalidCheckoutRequestStatus(_tokenId, _expectedStatus, checkoutRequest.status);

        return checkoutRequest;
    }

    /**
     * @notice Creates a custodian vault for a tokenId
     * The amount for first period is encumbered (it is available in the protocol since the verification time).
     *
     * @param _tokenId - the token ID
     * @param _custodianFee - the custodian fee details (amount and period)
     */
    function setupCustodianItemVault(uint256 _tokenId, FermionTypes.CustodianFee storage _custodianFee) internal {
        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_tokenId];

        vault.amount = _custodianFee.amount;
        vault.period = block.timestamp; // period is the time when the vault was created and then reset whenever the funds are released
    }

    /**
     * @notice Closes the custodian vault for a tokenId and releses the amount to the custodian
     *
     * Emits an AvailableFundsIncreased event if successful.
     *
     * @param _tokenId - the token ID
     * @param _custodianId - the custodian ID
     * @param _exchangeToken - the exchange token
     */
    function closeCustodianItemVault(uint256 _tokenId, uint256 _custodianId, address _exchangeToken) internal {
        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_tokenId];

        FundsLib.increaseAvailableFunds(_custodianId, _exchangeToken, vault.amount);

        vault.period = 0;
        vault.amount = 0;

        emit VaultAmountUpdated(_tokenId, 0);
    }

    /**
     * @notice When the first NFT is fractionalised, the custodian offer vault is setup.
     * The items' vaults are temporarily closed. If their balance was not zero, the custodian fee, proportional to the passed service time,
     * is released to the custodian and the remaining amount is transferred to the offer vault.
     *
     * Only the F-NFT contract can call this function. The F-NFT contract is trusted to call this function only when the initial fractionalisation happen.
     *
     * Emits an VaultAmountUpdated events
     *
     * Reverts if:
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _firstTokenId - the lowest token ID to add to the vault
     * @param _length - the number of tokens to add to the vault
     * @param _custodianVaultParameters - the custodian vault parameters
     */
    function setupCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionTypes.CustodianVaultParameters calldata _custodianVaultParameters
    ) external {
        // Only F-NFT contract can call it
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        (uint256 offerId, uint256 amountToTransfer) = addItemToCustodianOfferVault(_firstTokenId, _length, pl);

        // no need to worry this gets overwritten. If `setupCustodianOfferVault` is called the second time with the same offer it
        //it means that all items from the collection were recombined, and new parameters can be set
        pl.custodianVaultParameters[offerId] = _custodianVaultParameters;

        FermionTypes.CustodianFee storage offerVault = pl.vault[offerId];
        offerVault.period = block.timestamp;
        offerVault.amount += amountToTransfer;

        emit VaultAmountUpdated(offerId, offerVault.amount);
    }

    /**
     * @notice Adds aditional items to the existing custodian offer vault.
     *
     * Only the F-NFT contract can call this function. The F-NFT contract is trusted to call this function only when additional fractionalisations happen.
     *
     * Reverts if:
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _firstTokenId - the lowest token ID to add to the vault
     * @param _length - the number of tokens to add to the vault
     */
    function addItemToCustodianOfferVault(uint256 _firstTokenId, uint256 _length) external {
        addItemToCustodianOfferVault(_firstTokenId, _length, FermionStorage.protocolLookups());
    }

    /**
     * @notice Adds aditional items to the existing custodian offer vault.
     *
     * Reverts if:
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _firstTokenId - the lowest token ID to add to the vault
     * @param _length - the number of tokens to add to the vault
     * @param pl - the protocol lookups storage
     */
    function addItemToCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionStorage.ProtocolLookups storage pl
    ) internal returns (uint256 offerId, uint256 amountToTransfer) {
        // not testing the checkout request status. After confirming that the called is the FNFT address, we know
        // that fractionalisation can happen only if the item was checked-in
        FermionTypes.Offer storage offer;
        (offerId, offer) = FermionStorage.getOfferFromTokenId(_firstTokenId);
        if (msg.sender != pl.wrapperAddress[offerId]) revert AccessDenied(msg.sender); // not using msgSender() since the FNFT will never use meta transactions

        uint256 custodianId = offer.custodianId;
        address exchangeToken = offer.exchangeToken;
        FermionTypes.CustodianFee memory custodianFee = offer.custodianFee;
        for (uint256 i = 0; i < _length; i++) {
            // temporary close individual vaults and transfer the amount for unused periods to the offer vault
            uint256 tokenId = _firstTokenId + i;
            FermionTypes.CustodianFee storage itemVault = pl.vault[tokenId];

            // unused period ?
            uint256 balance = itemVault.amount;
            if (balance > 0) {
                uint256 lastReleased = itemVault.period;
                uint256 custodianPayoff = ((block.timestamp - lastReleased) * custodianFee.amount) /
                    custodianFee.period;

                if (custodianPayoff > balance) {
                    // This happens if the F-NFT owner was not paying the custodian fee and the forceful fractionalisation did not happen
                    // The custodian gets everything that's in the vault, but they missed the chance to get the custodian fee via fractionalisation
                    custodianPayoff = balance;
                }
                amountToTransfer += (balance - custodianPayoff);

                itemVault.amount = custodianPayoff;
            }
            closeCustodianItemVault(tokenId, custodianId, exchangeToken);
        }
    }

    /**
     * @notice Removes the item from the custodian offer vault. This happens when a buyout auction is finalized.
     * The custodian fee, proportional to the passed service time, is released to the custodian and the remaining amount is transferred to the
     * Fermion F-NFT contract where it's added to auction proceeds.
     *
     * Only the F-NFT contract can call this function. The F-NFT contract is trusted to call this function only when buyout auction is finalized.
     *
     * Reverts if:
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _tokenId - the token id to remove from the vault
     * @param _nftCount - number of currently fractionalised NFTs in the collection
     */
    function removeItemFromCustodianOfferVault(
        uint256 _tokenId,
        uint256 _nftCount
    ) external returns (uint256 released) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        // Only F-NFT contract can call it
        uint256 offerId;
        FermionTypes.Offer storage offer;
        (offerId, offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        address wrapperAddress = pl.wrapperAddress[offerId];
        if (msg.sender != wrapperAddress) revert AccessDenied(msg.sender); // not using msgSender() since the FNFT will never use meta transactions

        // trust the F-NFT contract that the token was added to offer vault at some point, i.e. it was fractionalised
        FermionTypes.CustodianFee storage offerVault = pl.vault[offerId];
        // offerVault.period = block.timestamp;

        FermionTypes.CustodianFee storage custodianFee = offer.custodianFee;
        uint256 vaultBalance = offerVault.amount;
        uint256 itemBalance = vaultBalance / _nftCount;
        uint256 lastReleased = offerVault.period;

        address exchangeToken = offer.exchangeToken;
        uint256 custodianPayoff = ((block.timestamp - lastReleased) * custodianFee.amount) / custodianFee.period;
        if (custodianPayoff > itemBalance) {
            // This happens if the vault balance fell below auction threshold and the forceful fractionalisation did not happen
            // The custodian gets everything that's in the vault, but they missed the chance to get the custodian fee via fractionalisation
            custodianPayoff = itemBalance;
            FundsLib.increaseAvailableFunds(offer.custodianId, exchangeToken, custodianPayoff);
        }

        unchecked {
            released = itemBalance - custodianPayoff;
            offerVault.amount -= itemBalance;
        }

        if (_nftCount == 1) {
            // closing the offer vault
            offerVault.period = 0;
        }

        // setup back the individual custodian vault
        setupCustodianItemVault(_tokenId, custodianFee);

        emit VaultAmountUpdated(offerId, offerVault.amount);

        FundsLib.transferFundsFromProtocol(exchangeToken, payable(wrapperAddress), released);
    }
}
