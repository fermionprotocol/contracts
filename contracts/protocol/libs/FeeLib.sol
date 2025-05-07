// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import { FermionStorage } from "./Storage.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FundsErrors } from "../domain/Errors.sol";
import { MathLib } from "./MathLib.sol";

/**
 * @title FeeLib
 *
 * @notice Fee related methods used by multiple facets
 */
library FeeLib {
    /**
     * @notice Gets the protocol fee percentage based on protocol fee table
     *
     * @dev This function calculates the protocol fee percentage for specific token and price.
     * If the token has a custom fee table configured, it returns the corresponding fee percentage
     * for the price range. If the token does not have a custom fee table, it falls back
     * to the default protocol fee percentage.
     *
     *
     * @param _exchangeToken - The address of the token being used for the exchange.
     * @param _price - The price of the item or service in the exchange.
     *
     * @return the protocol fee percentage for given price and exchange token
     */
    function getProtocolFeePercentage(address _exchangeToken, uint256 _price) internal view returns (uint16) {
        FermionStorage.ProtocolConfig storage config = FermionStorage.protocolConfig();
        uint256[] storage priceRanges = config.tokenPriceRanges[_exchangeToken];
        uint16[] storage feePercentages = config.tokenFeePercentages[_exchangeToken];

        // If the token has a custom fee table, find the appropriate percentage
        uint256 priceRangesLength = priceRanges.length;
        uint256 i;
        unchecked {
            if (priceRangesLength > 0) {
                for (; i < priceRangesLength - 1; ++i) {
                    if (_price <= priceRanges[i]) {
                        // Return the fee percentage for the matching price range
                        return feePercentages[i];
                    }
                }
                // If price exceeds all ranges, use the highest fee percentage
                return feePercentages[i];
            }
        }

        // If no custom fee table exists, fallback to using the default protocol percentage
        return config.protocolFeePercentage;
    }

    /**
     * @notice Calculates the Fermion and facilitator fees for the specified price and validates that the total
     *         fees are below the price.
     *
     * @dev This function applies percentage-based fees for Fermion and the facilitator. It checks if the total
     *      fees (including verifier and Boson protocol fees) are less than the total price.
     *
     * Reverts if:
     * - The sum of all fees exceeds the price.
     *
     * @param price The price of the NFT being unwrapped.
     * @param bosonProtocolFee The fee amount to be paid to the Boson Protocol.
     * @param offer The Fermion offer containing details of the sale.
     *
     * @return fermionFeeAmount The calculated fee amount to be paid to the Fermion Protocol.
     * @return facilitatorFeeAmount The calculated fee amount to be paid to the facilitator.
     */
    function calculateAndValidateFees(
        uint256 price,
        uint256 bosonProtocolFee,
        FermionTypes.Offer storage offer
    ) internal view returns (uint256 fermionFeeAmount, uint256 facilitatorFeeAmount) {
        // Calculate facilitator and fermion fees
        facilitatorFeeAmount = MathLib.applyPercentage(price, offer.facilitatorFeePercent);
        fermionFeeAmount = MathLib.applyPercentage(price, getProtocolFeePercentage(offer.exchangeToken, price));
        // Calculate the sum of all fees
        uint256 feesSum = facilitatorFeeAmount + fermionFeeAmount + offer.verifierFee + bosonProtocolFee;

        // Check if the sum of all fees is lower than the price
        if (price < feesSum) {
            revert FundsErrors.PriceTooLow(price, feesSum);
        }

        return (fermionFeeAmount, facilitatorFeeAmount);
    }
}
