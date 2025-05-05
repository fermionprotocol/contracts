// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { OfferErrors, FermionGeneralErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Access } from "../bases/mixins/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { RoyaltiesLib } from "../libs/RoyaltiesLib.sol";
import { IOfferEvents } from "../interfaces/events/IOfferEvents.sol";

import { IERC721Metadata } from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";

/**
 * @title RoyaltiesFacet
 *
 * @notice Handles royalties.
 */
contract RoyaltiesFacet is OfferErrors, Access {
    /**
     * @notice Internal function to update the royalty recipients, used by both single and batch update functions.
     *
     * Emits an OfferRoyaltyInfoUpdated event if successful.
     *
     * Reverts if:
     * - The offers region of protocol is paused
     * - Offer does not exist
     * - Caller is not the assistant of the offer
     * - New royalty info is invalid
     *
     *  @param _offerIds - the list of the ids of the offers to be updated
     *  @param _royaltyInfo - new royalty info
     */
    function updateOfferRoyaltyRecipients(
        uint256[] calldata _offerIds,
        FermionTypes.RoyaltyInfo calldata _royaltyInfo
    ) external notPaused(FermionTypes.PausableRegion.Offer) nonReentrant {
        uint256 sellerId;
        FermionStorage.SellerLookups storage sellerLookups;
        uint256 offerIdsLength = _offerIds.length;
        for (uint256 i; i < offerIdsLength; i++) {
            // Make sure the caller is the assistant, offer exists and is not voided
            FermionTypes.Offer storage offer = FermionStorage.protocolEntities().offer[_offerIds[i]];
            if (sellerId != offer.sellerId) {
                sellerId = offer.sellerId;
                sellerLookups = FermionStorage.protocolLookups().sellerLookups[sellerId];
            } else {
                sellerLookups = sellerLookups;
                // A workaround to avoid uninitialized variable warning.
                // This more efficient than initializing it before the loop to FermionStorage.protocolLookups().sellerLookups[0]
            }

            EntityLib.validateSellerAssistantOrFacilitator(sellerId, offer.facilitatorId);

            RoyaltiesLib.validateRoyaltyInfo(sellerLookups, sellerId, _royaltyInfo);

            offer.royaltyInfo = _royaltyInfo;

            // Notify watchers of state change
            emit IOfferEvents.OfferRoyaltyInfoUpdated(_offerIds[i], sellerId, _royaltyInfo);
        }
    }

    /**
     * @notice Gets EIP2981 style royalty information for a chosen offer or exchange.
     *
     * EIP2981 supports only 1 recipient, therefore this method defaults to the recipient at index 0.
     * This method is not exactly compliant with EIP2981, since it does not accept `salePrice` and does not return `royaltyAmount,
     * but it rather returns `royaltyPercentage` which is the sum of all bps (exchange can have multiple royalty recipients).
     *
     * This function is meant to be primarily used by Fermion FNFT, which implements EIP2981.
     *
     * @param _tokenId -  token id
     * @return receiver - the address of the royalty receiver
     * @return royaltyPercentage - the royalty percentage in bps
     */
    function getEIP2981Royalties(uint256 _tokenId) external view returns (address receiver, uint256 royaltyPercentage) {
        // EIP2981 returns only 1 recipient. Sum all bps and return admin address as recipient
        (FermionTypes.RoyaltyInfo storage royaltyInfo, address defaultRecipient) = fetchRoyalties(_tokenId);

        uint256 recipientLength = royaltyInfo.recipients.length;
        if (recipientLength == 0) return (address(0), uint256(0));

        uint256 totalBps = getTotalRoyaltyPercentage(royaltyInfo.bps);

        return (royaltyInfo.recipients[0] == address(0) ? defaultRecipient : royaltyInfo.recipients[0], totalBps);
    }

    /**
     * @notice Gets royalty information for a given token.
     *
     * Returns a list of royalty recipients and corresponding bps. Format is compatible with Manifold and Foundation royalties
     * and can be directly used by royalty registry.
     *
     * @param _tokenId - tokenId
     * @return recipients - list of royalty recipients
     * @return bps - list of corresponding bps
     */
    function getRoyalties(
        uint256 _tokenId
    ) external view returns (address payable[] memory recipients, uint256[] memory bps) {
        (FermionTypes.RoyaltyInfo memory royaltyInfo, address defaultRecipient) = fetchRoyalties(_tokenId);

        // replace default recipient with the default recipient (admin) address
        for (uint256 i; i < royaltyInfo.recipients.length; ++i) {
            if (royaltyInfo.recipients[i] == address(0)) {
                royaltyInfo.recipients[i] = payable(defaultRecipient);
            }
        }

        return (royaltyInfo.recipients, royaltyInfo.bps);
    }

    /**
     * @notice Internal helper to get royalty information and seller for a chosen token id.
     *
     * Reverts if offer has no royalties.
     *
     * @param _tokenId - the token id
     * @return royaltyInfo - list of royalty recipients and corresponding bps
     * @return defaultRecipient - the seller's default recipient address
     */
    function fetchRoyalties(
        uint256 _tokenId
    ) internal view returns (FermionTypes.RoyaltyInfo storage royaltyInfo, address defaultRecipient) {
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        address fermionFNFTAddress = FermionStorage.protocolLookups().offerLookups[offerId].fermionFNFTAddress;
        if (fermionFNFTAddress == address(0)) {
            // Token not preminted and wrapped yet
            revert FermionGeneralErrors.InvalidTokenId(fermionFNFTAddress, _tokenId);
        } else if (fermionFNFTAddress != msg.sender) {
            // This check is necessary only if the call is not from the FNFT contract, since that contract does the check anyway
            try IERC721Metadata(fermionFNFTAddress).tokenURI(_tokenId) returns (string memory uri) {
                // fermionFNFT will not return malformed URIs, so we can safely ignore the return value
            } catch {
                revert FermionGeneralErrors.InvalidTokenId(fermionFNFTAddress, _tokenId);
            }
        }

        defaultRecipient = FermionStorage.protocolEntities().entityData[offer.sellerId].admin;
        royaltyInfo = offer.royaltyInfo;
    }

    /**
     * @notice Helper function that calculates the total royalty percentage for a given exchange
     *
     * @param _bps - storage slot for array of royalty percentages
     * @return totalBps - the total royalty percentage
     */
    function getTotalRoyaltyPercentage(uint256[] storage _bps) internal view returns (uint256 totalBps) {
        uint256 bpsLength = _bps.length;
        for (uint256 i; i < bpsLength; ++i) {
            totalBps += _bps[i];
        }
    }
}
