// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPriceOracle
 * @dev Interface defining the price oracle. All RWA price oracle should comply to this interface.
 */
interface IPriceOracle {
    /**
     * @notice Gets the latest price from the oracle.
     * @return price The latest price.
     * @dev Reverts with `InvalidPrice` if the oracle cannot provide a valid price.
     */
    function getPrice() external view returns (uint256 price);

    /**
     * @notice Error indicating that the price provided by the oracle is invalid.
     */
    error InvalidPrice();
}
