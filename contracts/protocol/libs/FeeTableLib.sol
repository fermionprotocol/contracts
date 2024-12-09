// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import { FermionStorage } from "./Storage.sol";

/**
 * @title FeeTableLib
 *
 * @notice FeeTable related methods used by multiple facets
 */
library FeeTableLib {
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
        if (priceRangesLength > 0) {
            for (uint256 i; i < priceRangesLength - 1; ++i) {
                if (_price <= priceRanges[i]) {
                    // Return the fee percentage for the matching price range
                    return feePercentages[i];
                }
            }
            // If price exceeds all ranges, use the highest fee percentage
            return feePercentages[priceRangesLength - 1];
        }

        // If no custom fee table exists, fallback to using the default protocol percentage
        return config.protocolFeePercentage;
    }
}
