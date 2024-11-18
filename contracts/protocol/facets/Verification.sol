// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { HUNDRED_PERCENT } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { VerificationErrors, FermionGeneralErrors, SignatureErrors } from "../domain/Errors.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { IBosonProtocol } from "../interfaces/IBosonProtocol.sol";
import { IVerificationEvents } from "../interfaces/events/IVerificationEvents.sol";
import { FermionFNFTLib } from "../libs/FermionFNFTLib.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { EIP712 } from "../libs/EIP712.sol";

/**
 * @title VerificationFacet
 *
 * @notice Handles RWA verification.
 */
contract VerificationFacet is Context, Access, EIP712, VerificationErrors, IVerificationEvents {
    using FermionFNFTLib for address;

    bytes32 private constant SIGNED_PROPOSAL_TYPEHASH =
        keccak256(bytes("SignedProposal(uint256 tokenId,uint16 buyerPercent,bytes32 metadataURIDigest)"));

    IBosonProtocol private immutable BOSON_PROTOCOL;

    constructor(address _bosonProtocol, address _fermionProtocolAddress) EIP712(_fermionProtocolAddress) {
        if (_bosonProtocol == address(0)) revert FermionGeneralErrors.InvalidAddress();
        BOSON_PROTOCOL = IBosonProtocol(_bosonProtocol);
    }

    /**
     * @notice Submit a verdict
     *
     * Emits an VerdictSubmitted event
     *
     * If the revised metadata was already submitted, the verifier can submit the verdict only
     * by calling `removeRevisedMetadataAndSubmitVerdict`.
     *
     * Reverts if:
     * - Verification region is paused
     * - Caller is not the verifier's assistant
     * - Verdict is already submitted
     * - The revised metadata was submitted
     *
     * @param _tokenId - the token ID
     * @param _verificationStatus - the verification status
     */
    function submitVerdict(uint256 _tokenId, FermionTypes.VerificationStatus _verificationStatus) external {
        getFundsAndPayVerifier(_tokenId, true);
        submitVerdictInternal(_tokenId, _verificationStatus, false);
    }

    /**
     * @notice Submit a revised metadata
     *
     * Emits a RevisedMetadataSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Caller is not the verifier's assistant
     * - The metadata is empty
     *
     * @param _tokenId - the token ID
     * @param _newMetadata - the uri of the new metadata
     */
    function submitRevisedMetadata(
        uint256 _tokenId,
        string memory _newMetadata
    ) external notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        if (bytes(_newMetadata).length == 0) revert EmptyMetadata();

        FermionStorage.TokenLookups storage tokenLookups = FermionStorage.protocolLookups().tokenLookups[_tokenId];

        if (bytes(tokenLookups.revisedMetadata).length == 0) {
            getFundsAndPayVerifierUnguarded(_tokenId, true);
        } else {
            (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
            EntityLib.validateAccountRole(
                offer.verifierId,
                _msgSender(),
                FermionTypes.EntityRole.Verifier,
                FermionTypes.AccountRole.Assistant
            );
        }

        updateMetadataAndResetProposals(tokenLookups, _newMetadata, _tokenId);
    }

    /**
     * @notice If the revised metadata is incorrect, remove it and submit a verdict
     *
     * Emits a RevisedMetadataSubmitted and VerdictSubmitted events
     *
     * Reverts if:
     * - Verification region is paused
     * - The item has not been revised
     * - The caller is not the verifier's assistant
     *
     * @param _tokenId - the token ID
     * @param _verificationStatus - the verification status
     */
    function removeRevisedMetadataAndSubmitVerdict(
        uint256 _tokenId,
        FermionTypes.VerificationStatus _verificationStatus
    ) external notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        FermionStorage.TokenLookups storage tokenLookups = FermionStorage.protocolLookups().tokenLookups[_tokenId];

        if (bytes(tokenLookups.revisedMetadata).length == 0) revert EmptyMetadata();

        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        EntityLib.validateAccountRole(
            offer.verifierId,
            _msgSender(),
            FermionTypes.EntityRole.Verifier,
            FermionTypes.AccountRole.Assistant
        );

        updateMetadataAndResetProposals(tokenLookups, "", _tokenId);

        submitVerdictInternal(_tokenId, _verificationStatus, false);
    }

    /**
     * @notice Submit a proposal for the buyer and seller split if the item has been revised
     *
     * Emits a ProposalSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Buyer percentage is invalid (greater than 100%)
     * - The item has not been revised
     * - The metadata URI digest does not match the revised metadata digest
     * - The caller is not the buyer or seller
     *
     * @param _tokenId - the token ID
     * @param _buyerPercent - the percentage the buyer will receive
     * @param _metadataURIDigest - keccak256 of the revised metadata URI
     */
    function submitProposal(uint256 _tokenId, uint16 _buyerPercent, bytes32 _metadataURIDigest) external {
        submitProposalInternal(_tokenId, _buyerPercent, _metadataURIDigest, _msgSender(), address(0));
    }

    /**
     * @notice Submit a proposal for the buyer and seller split if the item has been revised, using the other party's signature
     *
     * Reverts if:
     * - The signature verification fails
     * - Verification region is paused
     * - Buyer percentage is invalid (greater than 100%)
     * - The item has not been revised
     * - The metadata URI digest does not match the revised metadata digest
     * - The caller is not the buyer or seller
     *
     * Emits a ProposalSubmitted event
     *
     * @param _tokenId - the token ID
     * @param _buyerPercent - the percentage the buyer will receive
     * @param _metadataURIDigest - keccak256 of the revised metadata URI
     * @param _signer - the signer of the proposal
     * @param _signature - the signature of the proposal
     */
    function submitSignedProposal(
        uint256 _tokenId,
        uint16 _buyerPercent,
        bytes32 _metadataURIDigest,
        address _signer,
        Signature memory _signature
    ) external {
        // verify signature
        bytes32 messageHash = keccak256(
            abi.encode(SIGNED_PROPOSAL_TYPEHASH, _tokenId, _buyerPercent, _metadataURIDigest)
        );

        verify(_signer, messageHash, _signature);

        submitProposalInternal(_tokenId, _buyerPercent, _metadataURIDigest, _msgSender(), _signer);
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
        FermionStorage.TokenLookups storage tokenLookups = FermionStorage.protocolLookups().tokenLookups[_tokenId];
        uint256 timeout = tokenLookups.itemVerificationTimeout;
        if (block.timestamp < timeout) revert VerificationTimeoutNotPassed(timeout, block.timestamp);

        bool inactiveVerifier = bytes(tokenLookups.revisedMetadata).length == 0;

        if (inactiveVerifier) {
            getFundsAndPayVerifier(_tokenId, false);
        }
        submitVerdictInternal(_tokenId, FermionTypes.VerificationStatus.Rejected, inactiveVerifier);
        delete tokenLookups.revisedMetadata;
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
            revert VerificationTimeoutTooLong(_newTimeout, maxItemVerificationTimeout);
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
     * @notice Get token's revised metadata URI
     * If token has no revised metadata, refer to corresponfing offer's metadata URI
     *
     * @param _tokenId Fermion FNFT token ID
     *
     * @return revisedMetadata Token's revised metadata
     */
    function getRevisedMetadata(uint256 _tokenId) external view returns (string memory revisedMetadata) {
        return FermionStorage.protocolLookups().tokenLookups[_tokenId].revisedMetadata;
    }

    /**
     * @notice Get the buyer and seller proposals for a specific token
     *
     * @param _tokenId - the token ID
     *
     * @return buyer - the buyer's proposal
     * @return seller - the seller's proposal
     */
    function getProposals(uint256 _tokenId) external view returns (uint16 buyer, uint16 seller) {
        FermionStorage.TokenLookups storage tokenLookups = FermionStorage.protocolLookups().tokenLookups[_tokenId];
        buyer = tokenLookups.buyerSplitProposal;
        seller = tokenLookups.sellerSplitProposal;
    }

    /**
     * @notice Transfer the funds from Boson to Fermion and pay the verifier
     *
     * Reverts if:
     * - Verification region is paused
     * - The caller is not the verifier's assistant
     * - The funds were already withdrawn
     *
     * @param _tokenId - the token ID
     * @param _payVerifier - indicator if the verifier should be paid
     */
    function getFundsAndPayVerifier(
        uint256 _tokenId,
        bool _payVerifier
    ) internal notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        getFundsAndPayVerifierUnguarded(_tokenId, _payVerifier);
    }

    /**
     * @notice Transfer the funds from Boson to Fermion and pay the verifier
     *
     * Reverts if:
     * - The caller is not the verifier's assistant
     * - The funds were already withdrawn
     *
     * @param _tokenId - the token ID
     * @param _payVerifier - indicator if the verifier should be paid
     */
    function getFundsAndPayVerifierUnguarded(uint256 _tokenId, bool _payVerifier) internal {
        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        uint256 verifierId = offer.verifierId;

        // Check the caller is the verifier's assistant
        if (_payVerifier) {
            EntityLib.validateAccountRole(
                verifierId,
                _msgSender(),
                FermionTypes.EntityRole.Verifier,
                FermionTypes.AccountRole.Assistant
            );
        }

        BOSON_PROTOCOL.completeExchange(_tokenId & type(uint128).max);

        address exchangeToken = offer.exchangeToken;
        uint256 withdrawalAmount = FermionStorage.protocolLookups().tokenLookups[_tokenId].itemPrice +
            offer.sellerDeposit;
        if (withdrawalAmount > 0) {
            uint256 bosonSellerId = FermionStorage.protocolStatus().bosonSellerId;
            address[] memory tokenList = new address[](1);
            uint256[] memory amountList = new uint256[](1);
            tokenList[0] = exchangeToken;
            amountList[0] = withdrawalAmount;
            BOSON_PROTOCOL.withdrawFunds(bosonSellerId, tokenList, amountList);
        }

        if (_payVerifier) FundsLib.increaseAvailableFunds(verifierId, exchangeToken, offer.verifierFee);
    }

    /**
     * @notice Submit a verdict
     *
     * Emits an VerdictSubmitted event
     *
     * Reverts if:
     * - Caller is not the verifier's assistant
     * - The item has pending revised metadata and the verdict is verified
     *
     * @param _tokenId - the token ID
     * @param _verificationStatus - the verification status
     * @param _afterTimeout - indicator if the verification is rejected after timeout
     */
    function submitVerdictInternal(
        uint256 _tokenId,
        FermionTypes.VerificationStatus _verificationStatus,
        bool _afterTimeout
    ) internal {
        uint256 tokenId = _tokenId;
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(tokenId);
        uint256 verifierId = offer.verifierId;

        {
            FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
            address exchangeToken = offer.exchangeToken;
            uint256 sellerDeposit = offer.sellerDeposit;
            FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[tokenId];
            uint256 remainder = tokenLookups.itemPrice - offer.verifierFee;

            unchecked {
                // if the item was revised, payout the buyer and do the other calcualtion on a new price
                uint256 buyerSplitProposal = tokenLookups.buyerSplitProposal;
                if (buyerSplitProposal > 0) {
                    uint256 buyerRevisedPayout = FundsLib.applyPercentage(remainder, buyerSplitProposal);

                    remainder -= buyerRevisedPayout;

                    uint256 buyerId = EntityLib.getOrCreateBuyerId(tokenLookups.initialBuyer, pl);
                    FundsLib.increaseAvailableFunds(buyerId, exchangeToken, buyerRevisedPayout);
                }

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
                pl.offerLookups[offerId].fermionFNFTAddress.pushToNextTokenState(
                    tokenId,
                    FermionTypes.TokenState.Verified
                );
            } else {
                address buyerAddress = pl.offerLookups[offerId].fermionFNFTAddress.burn(tokenId);

                uint256 buyerId = EntityLib.getOrCreateBuyerId(buyerAddress, pl);

                if (_afterTimeout) {
                    remainder += offer.verifierFee;
                }

                // transfer the remainder to the buyer
                FundsLib.increaseAvailableFunds(buyerId, exchangeToken, remainder + sellerDeposit);
            }
        }

        emit VerdictSubmitted(verifierId, tokenId, _verificationStatus);
    }

    /**
     * @notice Internal helper to check the caller is one of the involved parties and check if the proposals match
     *
     * Emits a ProposalSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Buyer percentage is invalid (greater than 100%)
     * - The metadata URI digest does not match the revised metadata digest
     * - The caller is not the buyer or seller
     * - The item has not been revised
     *
     * @param _tokenId - the token ID
     * @param _buyerPercent - the percentage the buyer will receive
     * @param _metadataURIDigest - keccak256 of the revised metadata URI
     * @param _msgSender - the caller
     * @param _otherSigner - the other party's address (0 if not present)
     */
    function submitProposalInternal(
        uint256 _tokenId,
        uint16 _buyerPercent,
        bytes32 _metadataURIDigest,
        address _msgSender,
        address _otherSigner
    ) internal notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        if (_buyerPercent > HUNDRED_PERCENT) revert FermionGeneralErrors.InvalidPercentage(_buyerPercent);

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenId];
        {
            bytes memory revisedMetadata = bytes(tokenLookups.revisedMetadata);
            if (revisedMetadata.length == 0) revert EmptyMetadata();
            bytes32 expectedMetadataDigest = keccak256(revisedMetadata);
            if (expectedMetadataDigest != _metadataURIDigest)
                revert DigestMismatch(expectedMetadataDigest, _metadataURIDigest);
        }

        FermionTypes.SplitProposal memory splitProposal;

        {
            (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
            address initialBuyer = tokenLookups.initialBuyer;
            if (initialBuyer == address(0)) {
                // get the information from the fnft
                initialBuyer = IFermionFNFT(pl.offerLookups[offerId].fermionFNFTAddress).ownerOf(_tokenId);
                tokenLookups.initialBuyer = initialBuyer;
            }
            if (_msgSender == initialBuyer) {
                tokenLookups.buyerSplitProposal = _buyerPercent;

                splitProposal.buyer = _buyerPercent;

                if (_otherSigner == address(0)) {
                    splitProposal.seller = tokenLookups.sellerSplitProposal;
                    splitProposal.matching = _buyerPercent <= splitProposal.seller;
                } else {
                    EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId, _otherSigner);
                    tokenLookups.sellerSplitProposal = _buyerPercent;
                    splitProposal.seller = _buyerPercent;
                    splitProposal.matching = true;
                }
            } else {
                // check the caller is the seller
                EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId, _msgSender);

                tokenLookups.sellerSplitProposal = _buyerPercent;
                splitProposal.seller = _buyerPercent;

                if (_otherSigner == address(0)) {
                    splitProposal.buyer = tokenLookups.buyerSplitProposal;
                    splitProposal.matching = splitProposal.buyer > 0 && _buyerPercent >= splitProposal.buyer;
                    if (splitProposal.matching) tokenLookups.buyerSplitProposal = _buyerPercent;
                } else {
                    if (_otherSigner != initialBuyer) revert SignatureErrors.InvalidSigner(initialBuyer, _otherSigner);
                    tokenLookups.buyerSplitProposal = _buyerPercent;
                    splitProposal.buyer = _buyerPercent;
                    splitProposal.matching = true;
                }
            }
        }

        emit ProposalSubmitted(_tokenId, splitProposal.buyer, splitProposal.seller, _buyerPercent);

        if (splitProposal.matching) {
            submitVerdictInternal(_tokenId, FermionTypes.VerificationStatus.Verified, false);
        }
    }

    /**
     * @notice Updates the metadata and resets the proposals
     *
     * Emits a RevisedMetadataSubmitted event
     */
    function updateMetadataAndResetProposals(
        FermionStorage.TokenLookups storage tokenLookups,
        string memory _newMetadata,
        uint256 _tokenId
    ) internal {
        tokenLookups.revisedMetadata = _newMetadata;

        // updating the metadata resets the proposals
        delete tokenLookups.buyerSplitProposal;
        delete tokenLookups.sellerSplitProposal;

        emit RevisedMetadataSubmitted(_tokenId, _newMetadata);
    }
}
