// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { VerificationErrors } from "../domain/Errors.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { IBosonProtocol } from "../interfaces/IBosonProtocol.sol";
import { IVerificationEvents } from "../interfaces/events/IVerificationEvents.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";

/**
 * @title VerificationFacet
 *
 * @notice Handles RWA verification.
 */
contract VerificationFacet is Context, Access, VerificationErrors, IVerificationEvents {
    IBosonProtocol private immutable BOSON_PROTOCOL;

    constructor(address _bosonProtocol) {
        BOSON_PROTOCOL = IBosonProtocol(_bosonProtocol);
    }

    /**
     * @notice Submit a verdict
     *
     * Emits an VerdictSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Caller is not the verifier's assistant
     *
     * @param _tokenId - the token ID
     * @param _verificationStatus - the verification status
     */
    function submitVerdict(uint256 _tokenId, FermionTypes.VerificationStatus _verificationStatus) external {
        submitVerdictInternal(_tokenId, _verificationStatus, false);
    }

    /**
     * @notice Reject a verification if verifier is inactive
     *
     * Emits a VerdictSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Verification timeout has not passed
     *
     * @param _tokenId - the token ID
     */
    function verificationTimeout(uint256 _tokenId) external {
        uint256 timeout = FermionStorage.protocolLookups().itemVerificationTimeout[_tokenId];
        if (block.timestamp < timeout) revert VerificationTimeoutNotPassed(timeout, block.timestamp);

        submitVerdictInternal(_tokenId, FermionTypes.VerificationStatus.Rejected, true);
    }

    /**
     * @notice Change the verification timeout for a specific token
     *
     * Emits an ItemVerificationTimeoutChanged event
     *
     * Reverts if:
     * - Verification region is paused
     * - Caller is not the seller's assistant or facilitator
     *
     * @param _tokenId - the token ID
     * @param _newTimeout - the new verification timeout
     */
    function changeVerificationTimeout(
        uint256 _tokenId,
        uint256 _newTimeout
    ) external notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId);

        FermionStorage.protocolLookups().itemVerificationTimeout[_tokenId] = _newTimeout;

        emit ItemVerificationTimeoutChanged(_tokenId, _newTimeout);
    }

    /**
     * @notice Returns the verification timeout for a specific token
     *
     * @param _tokenId - the token ID
     */
    function getItemVerificationTimeout(uint256 _tokenId) external view returns (uint256) {
        return FermionStorage.protocolLookups().itemVerificationTimeout[_tokenId];
    }

    /**
     * @notice Submit a verdict
     *
     * Emits an VerdictSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Caller is not the verifier's assistant
     *
     * @param _tokenId - the token ID
     * @param _verificationStatus - the verification status
     * @param _afterTimeout - indicator if the verification is rejected after timeout
     */
    function submitVerdictInternal(
        uint256 _tokenId,
        FermionTypes.VerificationStatus _verificationStatus,
        bool _afterTimeout
    ) internal notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 verifierId = offer.verifierId;

        if (!_afterTimeout) {
            // Check the caller is the verifier's assistant
            EntityLib.validateWalletRole(
                verifierId,
                _msgSender(),
                FermionTypes.EntityRole.Verifier,
                FermionTypes.WalletRole.Assistant
            );
        }

        BOSON_PROTOCOL.completeExchange(_tokenId & type(uint128).max);

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        address exchangeToken = offer.exchangeToken;
        uint256 sellerDeposit = offer.sellerDeposit;
        uint256 offerPrice = pl.itemPrice[_tokenId];

        {
            uint256 bosonSellerId = FermionStorage.protocolStatus().bosonSellerId;
            address[] memory tokenList = new address[](1);
            uint256[] memory amountList = new uint256[](1);
            tokenList[0] = exchangeToken;
            amountList[0] = offerPrice + sellerDeposit;
            BOSON_PROTOCOL.withdrawFunds(bosonSellerId, tokenList, amountList);
        }

        uint256 remainder = offerPrice;
        unchecked {
            // pay the verifier
            uint256 verifierFee = offer.verifierFee;
            if (!_afterTimeout) FundsLib.increaseAvailableFunds(verifierId, exchangeToken, verifierFee);
            remainder -= verifierFee; // guaranteed to be positive

            // fermion fee
            uint256 fermionFeeAmount = FundsLib.applyPercentage(
                remainder,
                FermionStorage.protocolConfig().protocolFeePercentage
            );
            FundsLib.increaseAvailableFunds(0, exchangeToken, fermionFeeAmount); // Protocol fees are stored in entity 0
            remainder -= fermionFeeAmount;
        }

        if (_verificationStatus == FermionTypes.VerificationStatus.Verified) {
            // pay the facilitator
            uint256 facilitatorFeeAmount = FundsLib.applyPercentage(remainder, offer.facilitatorFeePercent);
            FundsLib.increaseAvailableFunds(offer.facilitatorId, exchangeToken, facilitatorFeeAmount);
            remainder = remainder - facilitatorFeeAmount + sellerDeposit;

            // transfer the remainder to the seller
            FundsLib.increaseAvailableFunds(offer.sellerId, exchangeToken, remainder);
            IFermionFNFT(pl.fermionFNFTAddress[offerId]).pushToNextTokenState(
                _tokenId,
                FermionTypes.TokenState.Verified
            );
        } else {
            address buyerAddress = IFermionFNFT(pl.fermionFNFTAddress[offerId]).burn(_tokenId);

            uint256 buyerId = EntityLib.getOrCreateBuyerId(buyerAddress, pl);

            if (_afterTimeout) {
                remainder += offer.verifierFee;
            }

            // transfer the remainder to the buyer
            FundsLib.increaseAvailableFunds(buyerId, exchangeToken, remainder + sellerDeposit);
        }

        emit VerdictSubmitted(verifierId, _tokenId, _verificationStatus);
    }
}
