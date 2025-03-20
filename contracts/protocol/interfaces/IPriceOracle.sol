// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPriceOracle
 * @dev Interface defining the price oracle. All RWA price oracle used by the protocol should comply to this interface.
 */
interface IPriceOracle {
    error InvalidPrice();
    error InvalidFeedAddress();
    error StalenessPeriodOutOfBounds(uint256 provided, uint256 min, uint256 max);

    /// @notice Event emitted when the price feed address is updated.
    event FeedUpdated(address indexed previousFeed, address indexed newFeed);

    /// @notice Event emitted when the staleness period is updated.
    event MaxStalenessPeriodUpdated(uint256 previousStalenessPeriod, uint256 newStalenessPeriod);

    /**
     * @notice Gets the latest price from the oracle.
     * @return price The latest price.
     * @dev Reverts with `InvalidPrice` if the oracle cannot provide a valid price.
     */
    function getPrice() external view returns (uint256 price);
}
