// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionStorage } from "../libs/Storage.sol";

/**
 * @title BackfillingFacet
 * @notice Handles backfilling of data during the v1.1.0 upgrade.
 *         This facet should only be active during the upgrade process.
 */
contract BackfillingFacet {
    event FeesBackfilled(
        uint256 indexed tokenId,
        uint256 bosonProtocolFee,
        uint256 fermionFeeAmount,
        uint256 verifierFee,
        uint256 facilitatorFeeAmount,
        uint256 itemFullPrice
    );

    struct FeeData {
        uint256 tokenId;
        uint256 bosonProtocolFee;
        uint256 fermionFeeAmount;
        uint256 verifierFee;
        uint256 facilitatorFeeAmount;
    }

    /**
     * @notice Backfills fees for Fermion v1.1.0.
     *
     * @dev This function must be called only during the upgrade process.
     *      The data must be pre-computed off-chain and provided as input.
     *
     * @param feeDataList The list of fee data for each token.
     */
    function backFillV1_1_0(FeeData[] calldata feeDataList) external {
        FermionStorage.ProtocolLookups storage lookups = FermionStorage.protocolLookups();
        uint256 length = feeDataList.length;
        unchecked {
            for (uint256 i; i < length; ++i) {
                FeeData calldata feeData = feeDataList[i];
                FermionStorage.TokenLookups storage tokenLookup = lookups.tokenLookups[feeData.tokenId];

                if (tokenLookup.bosonProtocolFee != 0) {
                    continue;
                }

                uint256 itemFullPrice = tokenLookup.itemPrice;

                tokenLookup.bosonProtocolFee = feeData.bosonProtocolFee;
                tokenLookup.itemPrice = itemFullPrice + feeData.bosonProtocolFee;
                tokenLookup.fermionFeeAmount = feeData.fermionFeeAmount;
                tokenLookup.verifierFee = feeData.verifierFee;
                tokenLookup.facilitatorFeeAmount = feeData.facilitatorFeeAmount;

                emit FeesBackfilled(
                    feeData.tokenId,
                    feeData.bosonProtocolFee,
                    feeData.fermionFeeAmount,
                    feeData.verifierFee,
                    feeData.facilitatorFeeAmount,
                    itemFullPrice
                );
            }
        }
    }
}
