// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { HUNDRED_PERCENT } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { VerificationErrors, FermionGeneralErrors } from "../domain/Errors.sol";
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
     *
     * @param _tokenId - the token ID
     * @param _verificationStatus - the verification status
     */
    function submitVerdict(uint256 _tokenId, FermionTypes.VerificationStatus _verificationStatus) external {
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
     * - New metadata is empty
     *
     * @param _tokenId - the token ID
     * @param _newMetadata - the uri of the new metadata
     */
    function submitRevisedMetadata(
        uint256 _tokenId,
        string memory _newMetadata
    ) external notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        uint256 tokenId = _tokenId;
        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(tokenId);

        EntityLib.validateAccountRole(
            offer.verifierId,
            _msgSender(),
            FermionTypes.EntityRole.Verifier,
            FermionTypes.AccountRole.Assistant
        );

        if (bytes(_newMetadata).length == 0) revert EmptyMetadata();

        FermionStorage.protocolLookups().tokenLookups[_tokenId].pendingRevisedMetadata = _newMetadata;

        emit RevisedMetadataSubmitted(tokenId, _newMetadata);
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
     * @notice Submit a proposal for the buyer and seller split if the item has been revised
     *
     * Emits a ProposalSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Buyer percentage is invalid (greater than 100%)
     * - The caller is not the buyer or seller
     * - The item has not been revised
     *
     * @param _tokenId - the token ID
     * @param _buyerPercent - the percentage the buyer will receive
     */
    function submitProposal(uint256 _tokenId, uint16 _buyerPercent) public {
        submitProposalInternal(_tokenId, _buyerPercent, _msgSender(), address(0));
    }

    /**
     * @notice Submit a proposal for the buyer and seller split if the item has been revised, using the other party's signature
     *
     * Reverts if:
     * - The signature verification fails
     * - Verification region is paused
     * - Buyer percentage is invalid (greater than 100%)
     * - The caller is not the buyer or seller
     * - The item has not been revised
     *
     * Emits a ProposalSubmitted event
     *
     * @param _tokenId - the token ID
     * @param _buyerPercent - the percentage the buyer will receive
     * @param _signer - the signer of the proposal
     * @param _signature - the signature of the proposal
     */
    function submitSignedProposal(
        uint256 _tokenId,
        uint16 _buyerPercent,
        address _signer,
        Signature memory _signature
    ) external {
        // verify signature
        bytes32 messageHash = keccak256(abi.encodePacked(_tokenId, _buyerPercent));

        verify(_signer, messageHash, _signature);

        submitProposalInternal(_tokenId, _buyerPercent, _msgSender(), _signer);
    }

    /**
     * @notice Submit a verdict
     *
     * Emits an VerdictSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
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

        BOSON_PROTOCOL.completeExchange(tokenId & type(uint128).max);
        {
            FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
            address exchangeToken = offer.exchangeToken;
            uint256 sellerDeposit = offer.sellerDeposit;
            FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[tokenId];
            uint256 offerPrice = tokenLookups.itemPrice;

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
                // pay the verifier, regardless of the verdict
                uint256 verifierFee = offer.verifierFee;
                if (!_afterTimeout) FundsLib.increaseAvailableFunds(verifierId, exchangeToken, verifierFee);
                remainder -= verifierFee; // guaranteed to be positive

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
                if (bytes(tokenLookups.pendingRevisedMetadata).length > 0)
                    revert PendingRevisedMetadata(tokenId, tokenLookups.pendingRevisedMetadata);

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
     * @notice Intermediary step before the verdict is submitted to make sure the token had a revised metadata
     *
     * @param _tokenId - the token ID
     * @param _tokenLookups - the token lookups storage
     */
    function acceptProposal(uint256 _tokenId, FermionStorage.TokenLookups storage _tokenLookups) internal {
        string storage pendingRevisedMetadata = _tokenLookups.pendingRevisedMetadata;
        if (bytes(pendingRevisedMetadata).length == 0) revert EmptyMetadata();

        _tokenLookups.pendingRevisedMetadata = "";
        submitVerdictInternal(_tokenId, FermionTypes.VerificationStatus.Verified, false);
    }

    /**
     * @notice Internal helper to check the caller is one of the involved parties and check if the proposals match
     *
     * Emits a ProposalSubmitted event
     *
     * Reverts if:
     * - Verification region is paused
     * - Buyer percentage is invalid (greater than 100%)
     * - The caller is not the buyer or seller
     * - The item has not been revised
     *
     * @param _tokenId - the token ID
     * @param _buyerPercent - the percentage the buyer will receive
     */
    function submitProposalInternal(
        uint256 _tokenId,
        uint16 _buyerPercent,
        address _msgSender,
        address _otherSigner
    ) internal notPaused(FermionTypes.PausableRegion.Verification) nonReentrant {
        if (_buyerPercent > HUNDRED_PERCENT) revert FermionGeneralErrors.InvalidPercentage(_buyerPercent);

        uint16 buyerSplitProposal;
        uint16 sellerSplitProposal;
        bool matchingProposal;

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenId];
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

                buyerSplitProposal = _buyerPercent;

                if (_otherSigner == address(0)) {
                    tokenLookups.sellerSplitProposal = _buyerPercent;
                    sellerSplitProposal = _buyerPercent;
                    matchingProposal = true;
                } else {
                    sellerSplitProposal = tokenLookups.sellerSplitProposal;
                    matchingProposal = _buyerPercent <= sellerSplitProposal;
                }
            } else {
                // check the caller is the seller
                EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId, _msgSender);

                tokenLookups.sellerSplitProposal = _buyerPercent;
                sellerSplitProposal = _buyerPercent;

                if (_otherSigner == address(0)) {
                    tokenLookups.buyerSplitProposal = _buyerPercent;
                    buyerSplitProposal = _buyerPercent;
                    matchingProposal = true;
                } else {
                    buyerSplitProposal = tokenLookups.buyerSplitProposal;
                    matchingProposal = buyerSplitProposal > 0 && _buyerPercent >= buyerSplitProposal;
                }
            }
        }
        emit ProposalSubmitted(_tokenId, buyerSplitProposal, sellerSplitProposal, _buyerPercent);

        if (matchingProposal) {
            acceptProposal(_tokenId, tokenLookups);
        }
    }
}
