// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { BOSON_DR_ID_OFFSET } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { Context } from "../libs/Context.sol";
import { IBosonProtocol } from "../interfaces/IBosonProtocol.sol";
import { IOfferEvents } from "../interfaces/events/IOfferEvents.sol";

/**
 * @title OfferFacet
 *
 * @notice Handles offer listing.
 */
contract OfferFacet is Context, FermionErrors, IOfferEvents {
    address private immutable BOSON_PROTOCOL;

    constructor(address _bosonProtocol) {
        BOSON_PROTOCOL = _bosonProtocol;
    }

    /**
     * @notice Create an offer
     *
     * Emits an OfferCreated event
     *
     * Reverts if:
     * - Caller is not the seller's assistant
     * - Invalid verifier or custodian ID is provided
     *
     * @param _sellerId Seller ID
     * @param _offer Offer to list
     */
    function createOffer(uint256 _sellerId, FermionTypes.Offer calldata _offer) external {
        address msgSender = msgSender();

        // Caller must be the seller's assistant
        if (
            !EntityLib.hasWalletRole(
                _sellerId,
                msgSender,
                FermionTypes.EntityRole.Seller,
                FermionTypes.WalletRole.Assistant,
                false
            )
        ) {
            revert WalletHasNoRole(
                _sellerId,
                msgSender,
                FermionTypes.EntityRole.Seller,
                FermionTypes.WalletRole.Assistant
            );
        }

        // Validate verifier and custodian IDs
        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();
        EntityLib.validateEntityRole(
            _offer.verifierId,
            pe.entityData[_offer.verifierId].roles,
            FermionTypes.EntityRole.Verifier
        );
        EntityLib.validateEntityRole(
            _offer.custodianId,
            pe.entityData[_offer.custodianId].roles,
            FermionTypes.EntityRole.Custodian
        );

        // Create offer in Boson
        uint256 bosonSellerId = FermionStorage.protocolStatus().bosonSellerId;
        IBosonProtocol.Offer memory bosonOffer;
        bosonOffer.sellerId = bosonSellerId;
        // bosonOffer.price = _offer.verifierFee; // Boson currently requires price to be 0; this will be enabled with 2.4.2 release
        bosonOffer.sellerDeposit = _offer.sellerDeposit;
        // bosonOffer.buyerCancelPenalty = _offer.verifierFee; // Boson currently requires buyerCancelPenalty to be 0; this will be enabled with 2.4.2 release
        bosonOffer.quantityAvailable = type(uint256).max; // unlimited offer
        bosonOffer.exchangeToken = _offer.exchangeToken;
        bosonOffer.priceType = IBosonProtocol.PriceType.Discovery;
        bosonOffer.metadataUri = _offer.metadataURI;
        bosonOffer.metadataHash = _offer.metadataHash;
        bosonOffer.royaltyInfo = new IBosonProtocol.RoyaltyInfo[](1);
        // bosonOffer.voided and bosonOffer.collectionIndex are not set, the defaults are fine

        IBosonProtocol.OfferDates memory bosonOfferDates;
        bosonOfferDates.validUntil = type(uint256).max; // unlimited offer. Sellers can limit it when they list preminted vouchers on external marketplaces
        // bosonOfferDates.validFrom, bosonOfferDates.voucherRedeemableFrom, bosonOfferDates.voucherRedeemableUntil are not set, the defaults are fine

        IBosonProtocol.OfferDurations memory bosonOfferDurations;
        bosonOfferDurations.disputePeriod = type(uint256).max; // TBD: how to limit the time verifier has to respond
        bosonOfferDurations.voucherValid = 1; // It could be 0, since in fermion offers, commit and redeem happen atomically, but Boson does not allow it
        bosonOfferDurations.resolutionPeriod = 7 days; // Not needed for fermion, but Boson requires it

        uint256 bosonOfferId = IBosonProtocol(BOSON_PROTOCOL).getNextOfferId();

        IBosonProtocol(BOSON_PROTOCOL).createOffer(
            bosonOffer,
            bosonOfferDates,
            bosonOfferDurations,
            bosonSellerId + BOSON_DR_ID_OFFSET,
            0, // no agent
            type(uint256).max // no fee limit
        );

        // Store fermion offer properties
        FermionStorage.protocolEntities().offer[bosonOfferId] = _offer;

        emit OfferCreated(_sellerId, _offer.verifierId, _offer.custodianId, _offer, bosonOfferId);
    }

    /**
     * @notice Add a supported token to the Boson dispute resolver. This is necessary for a succesful offer creation.
     *
     * Not restricted with onlyAdmin. The purpose of this method is to allow the seller to add supported tokens in boson if they
     * want to use them in their offers and not already added by the protocol.
     *
     * @param _tokenAddress Token address
     */
    function addSupportedToken(address _tokenAddress) external {
        IBosonProtocol.DisputeResolverFee[] memory disputeResolverFees = new IBosonProtocol.DisputeResolverFee[](1);
        disputeResolverFees[0] = IBosonProtocol.DisputeResolverFee({
            tokenAddress: _tokenAddress,
            tokenName: "",
            feeAmount: 0
        });

        uint256 bosonDisputeResolverId = FermionStorage.protocolStatus().bosonSellerId + BOSON_DR_ID_OFFSET;
        IBosonProtocol(BOSON_PROTOCOL).addFeesToDisputeResolver(bosonDisputeResolverId, disputeResolverFees);
    }

    /**
     * @notice Get an offer by ID
     *
     * @param _offerId Offer ID
     *
     * @return offer Offer details
     */
    function getOffer(uint256 _offerId) external view returns (FermionTypes.Offer memory offer) {
        return FermionStorage.protocolEntities().offer[_offerId];
    }
}
