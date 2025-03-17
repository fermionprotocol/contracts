// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import { FermionStorage } from "./Storage.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionGeneralErrors, OfferErrors } from "../domain/Errors.sol";
import { EntityLib } from "./EntityLib.sol";

/**
 * @title RoyaltiesLib
 *
 * @notice Royalties methods used by multiple facets
 */
library RoyaltiesLib {
    /**
     * @notice Validates that royalty info struct contains valid data
     *
     * Reverts if:
     * - Royalty recipient is not on seller's allow list
     * - Royalty percentage is less than the value decided by the admin
     * - Total royalty percentage is more than max royalty percentage
     *
     * @param _sellerLookups -  the storage pointer to seller lookups
     * @param _sellerId - the id of the seller
     * @param _royaltyInfo - the royalty info struct
     */
    function validateRoyaltyInfo(
        FermionStorage.SellerLookups storage _sellerLookups,
        uint256 _sellerId,
        FermionTypes.RoyaltyInfo memory _royaltyInfo
    ) internal {
        if (_royaltyInfo.recipients.length != _royaltyInfo.bps.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_royaltyInfo.recipients.length, _royaltyInfo.bps.length);

        mapping(uint256 => bool) storage isSellersRoyaltyRecipient = _sellerLookups.isSellersRoyaltyRecipient;

        uint256 totalRoyalties;
        uint256 recipientsLength = _royaltyInfo.recipients.length;
        for (uint256 i; i < recipientsLength; ++i) {
            if (_royaltyInfo.recipients[i] != address(0)) {
                uint256 royaltyRecipientId = EntityLib.getOrCreateEntityId(
                    _royaltyInfo.recipients[i],
                    FermionTypes.EntityRole.RoyaltyRecipient,
                    FermionStorage.protocolLookups()
                );

                if (royaltyRecipientId != _sellerId && !isSellersRoyaltyRecipient[royaltyRecipientId])
                    revert OfferErrors.InvalidRoyaltyRecipient(_royaltyInfo.recipients[i]);
            }

            totalRoyalties += _royaltyInfo.bps[i];
        }

        if (totalRoyalties > FermionStorage.protocolConfig().maxRoyaltyPercentage)
            revert OfferErrors.InvalidRoyaltyPercentage(totalRoyalties);
    }
}
