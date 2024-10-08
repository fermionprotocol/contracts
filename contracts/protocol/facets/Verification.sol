// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { VerificationErrors, FermionGeneralErrors, OfferErrors } from "../domain/Errors.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { IBosonProtocol } from "../interfaces/IBosonProtocol.sol";
import { IVerificationEvents } from "../interfaces/events/IVerificationEvents.sol";
import { FermionFNFTLib } from "../libs/FermionFNFTLib.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";

/**
 * @title VerificationFacet
 *
 * @notice Handles RWA verification.
 */
contract VerificationFacet is Context, Access, VerificationErrors, IVerificationEvents {
    IBosonProtocol private immutable BOSON_PROTOCOL;
    using FermionFNFTLib for address;

    constructor(address _bosonProtocol) {
        if (_bosonProtocol == address(0)) revert FermionGeneralErrors.InvalidAddress();
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
     * - Offer has phygitals and the phygitals have not been verified
     *
     * @param _tokenId - the token ID
     * @param _verificationStatus - the verification status
     */
    function submitVerdict(uint256 _tokenId, FermionTypes.VerificationStatus _verificationStatus) external {
        submitVerdictInternal(_tokenId, _verificationStatus, false);
    }

    /**
     * @notice Confirm that the phygitals in the vault match the items described in the item metadata
     *
     * Emits an PhygitalsVerified event
     *
     * Reverts if:
     * - Verification region is paused
     * - The offer does not have phygitals
     * - The phygitals have already been verified
     * - The caller is not the verifier or the buyer
     * - The FNFT is not in the unverified state
     * - The digest does not match the expected digest
     *
     * @param _tokenId - the token ID
     * @param _phygitalsDigest - the keccak256 digest of the phygitals
     */
    function verifyPhygitals(
        uint256 _tokenId,
        bytes32 _phygitalsDigest
    ) external notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        // check that the offer has phygitals
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        if (!offer.withPhygital) revert OfferErrors.NoPhygitalOffer(_tokenId);

        // check that phygitals not already verified
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenId];
        if (tokenLookups.phygitalsRecipient != 0) revert VerificationErrors.PhygitalsAlreadyVerified(_tokenId);

        // FNFT must be in the unverified state
        IFermionFNFT fermionFNFT = IFermionFNFT(pl.offerLookups[offerId].fermionFNFTAddress);
        FermionTypes.TokenState tokenState = fermionFNFT.tokenState(_tokenId);
        if (tokenState != FermionTypes.TokenState.Unverified) revert InvalidTokenState(_tokenId, tokenState);

        // only the verifier or the buyer can call this function
        address msgSender = _msgSender();

        address buyerAddress = fermionFNFT.ownerOf(_tokenId);

        if (
            buyerAddress != msgSender &&
            !EntityLib.hasAccountRole(
                offer.verifierId,
                msgSender,
                FermionTypes.EntityRole.Verifier,
                FermionTypes.AccountRole.Assistant,
                false
            )
        ) {
            revert FermionGeneralErrors.AccessDenied(msgSender);
        }

        // check that the digest is correct
        bytes32 expectedDigest = keccak256(abi.encode(tokenLookups.phygitals));
        if (expectedDigest != _phygitalsDigest)
            revert PhygitalsDigestMismatch(_tokenId, expectedDigest, _phygitalsDigest);

        uint256 phygitalsRecipient = EntityLib.getOrCreateBuyerId(buyerAddress, pl);
        tokenLookups.phygitalsRecipient = phygitalsRecipient;

        emit PhygitalsVerified(_tokenId, phygitalsRecipient, msgSender);
    }

    /**
     * @notice Reject a verification if verifier is inactive
     *
     * Emits a VerdictSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Verification timeout has not passed
     * - Offer has phygitals and the phygitals have not been verified
     *
     * @param _tokenId - the token ID
     */
    function verificationTimeout(uint256 _tokenId) external {
        uint256 timeout = FermionStorage.protocolLookups().tokenLookups[_tokenId].itemVerificationTimeout;
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
     * - New timeout is greater than the maximum timeout
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

        FermionStorage.TokenLookups storage tokenLookups = FermionStorage.protocolLookups().tokenLookups[_tokenId];
        uint256 maxItemVerificationTimeout = tokenLookups.itemMaxVerificationTimeout;
        if (_newTimeout > maxItemVerificationTimeout) {
            revert VerificationErrors.VerificationTimeoutTooLong(_newTimeout, maxItemVerificationTimeout);
        }

        tokenLookups.itemVerificationTimeout = _newTimeout;

        emit ItemVerificationTimeoutChanged(_tokenId, _newTimeout);
    }

    /**
     * @notice Returns the verification timeout for a specific token
     *
     * @param _tokenId - the token ID
     */
    function getItemVerificationTimeout(uint256 _tokenId) external view returns (uint256) {
        return FermionStorage.protocolLookups().tokenLookups[_tokenId].itemVerificationTimeout;
    }

    /**
     * @notice Submit a verdict
     *
     * Emits an VerdictSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Caller is not the verifier's assistant
     * - Offer has phygitals and the phygitals have not been verified
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
        uint256 tokenId = _tokenId;
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(tokenId);
        uint256 verifierId = offer.verifierId;

        if (!_afterTimeout) {
            // Check the caller is the verifier's assistant
            EntityLib.validateAccountRole(
                verifierId,
                _msgSender(),
                FermionTypes.EntityRole.Verifier,
                FermionTypes.AccountRole.Assistant
            );
        }

        // If offer is listed with phygitals, they must be verified before the verdict can be submitted
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[tokenId];
        bool hasPhygitals = offer.withPhygital;
        if (
            hasPhygitals &&
            _verificationStatus == FermionTypes.VerificationStatus.Verified && // if the item is rejected, phygitals are not required
            tokenLookups.phygitalsRecipient == 0
        ) revert PhygitalsVerificationMissing(tokenId);

        BOSON_PROTOCOL.completeExchange(tokenId & type(uint128).max);
        {
            address exchangeToken = offer.exchangeToken;
            uint256 sellerDeposit = offer.sellerDeposit;
            uint256 offerPrice = tokenLookups.itemPrice;
            {
                uint256 withdrawalAmount = offerPrice + sellerDeposit;
                if (withdrawalAmount > 0) {
                    uint256 bosonSellerId = FermionStorage.protocolStatus().bosonSellerId;
                    address[] memory tokenList = new address[](1);
                    uint256[] memory amountList = new uint256[](1);
                    tokenList[0] = exchangeToken;
                    amountList[0] = withdrawalAmount;
                    BOSON_PROTOCOL.withdrawFunds(bosonSellerId, tokenList, amountList);
                }
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
                address fermionFNFTAddress = pl.offerLookups[offerId].fermionFNFTAddress;
                fermionFNFTAddress.pushToNextTokenState(tokenId, FermionTypes.TokenState.Verified);

                // If item is verified, the phygital recipient is already stored
            } else {
                address buyerAddress = pl.offerLookups[offerId].fermionFNFTAddress.burn(tokenId);

                uint256 buyerId = EntityLib.getOrCreateBuyerId(buyerAddress, pl);

                if (_afterTimeout) {
                    remainder += offer.verifierFee;
                }

                // transfer the remainder to the buyer
                FundsLib.increaseAvailableFunds(buyerId, exchangeToken, remainder + sellerDeposit);

                if (hasPhygitals) {
                    pl.tokenLookups[tokenId].phygitalsRecipient = 0; // reset phygitals verification status, so the seller can withdraw them
                }
            }
        }

        emit VerdictSubmitted(verifierId, tokenId, _verificationStatus);
    }
}
