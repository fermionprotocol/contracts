// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../../interfaces/IPriceOracle.sol";
import "../../interfaces/chainlink/AggregatorV3Interface.sol";

/**
 * @title ChainlinkPriceOracle
 * @dev Oracle contract for fetching prices from a Chainlink feed.
 *      This contract ensures that the price is valid and not stale.
 */
contract ChainlinkPriceOracle is Initializable, OwnableUpgradeable, IPriceOracle {
    /// @notice The address of the Chainlink price feed.
    address public feed;

    /// @notice The maximum allowed staleness period for this price feed.
    uint256 public maxStalenessPeriod;

    /// @notice The minimum value allowed for the staleness period.
    uint256 public constant MIN_STALENESS_PERIOD = 1 minutes;

    /// @notice The maximum value allowed for the staleness period.
    uint256 public constant MAX_STALENESS_PERIOD = 20 days;

    /**
     * @notice Initializes the contract.
     * @param _owner The address of the owner.
     * @param _feed The address of the Chainlink price feed.
     * @param _maxStalenessPeriod The maximum allowed staleness period for the price.
     */
    function initialize(address _owner, address _feed, uint256 _maxStalenessPeriod) external initializer {
        __Ownable_init(_owner);
        _setFeedInternal(_feed);
        _setMaxStalenessPeriodInternal(_maxStalenessPeriod);
    }

    /**
     * @notice Gets the latest price from the oracle.
     * @return price The latest valid price from the Chainlink feed.
     * @dev Reverts if the price is invalid or too stale.
     */
    function getPrice() external view override returns (uint256 price) {
        (, int256 answer, , uint256 updatedAt, ) = AggregatorV3Interface(feed).latestRoundData();

        if (answer <= 0) {
            revert InvalidPrice();
        }

        if (block.timestamp - updatedAt > maxStalenessPeriod) {
            revert InvalidPrice();
        }

        price = uint256(answer);
    }

    /**
     * @notice Updates the Chainlink price feed address.
     * @param _feed The address of the new Chainlink price feed.
     * @dev Emits a `FeedUpdated` event upon success.
     */
    function setFeed(address _feed) external onlyOwner {
        address previousFeed = feed;
        _setFeedInternal(_feed);
        emit FeedUpdated(previousFeed, _feed);
    }

    /**
     * @notice Updates the maximum staleness period for the price.
     * @param _maxStalenessPeriod The new staleness period.
     * @dev Emits a `MaxStalenessPeriodUpdated` event upon success.
     */
    function setMaxStalenessPeriod(uint256 _maxStalenessPeriod) external onlyOwner {
        uint256 previousStalenessPeriod = maxStalenessPeriod;
        _setMaxStalenessPeriodInternal(_maxStalenessPeriod);
        emit MaxStalenessPeriodUpdated(previousStalenessPeriod, _maxStalenessPeriod);
    }

    /**
     * @dev Internal function to update the Chainlink price feed.
     * @param _feed The address of the Chainlink price feed.
     */
    function _setFeedInternal(address _feed) internal {
        if (_feed == address(0)) {
            revert InvalidFeedAddress();
        }
        feed = _feed;
    }

    /**
     * @dev Internal function to update the maximum staleness period.
     * @param _maxStalenessPeriod The new staleness period.
     */
    function _setMaxStalenessPeriodInternal(uint256 _maxStalenessPeriod) internal {
        if (_maxStalenessPeriod < MIN_STALENESS_PERIOD || _maxStalenessPeriod > MAX_STALENESS_PERIOD) {
            revert StalenessPeriodOutOfBounds(_maxStalenessPeriod, MIN_STALENESS_PERIOD, MAX_STALENESS_PERIOD);
        }
        maxStalenessPeriod = _maxStalenessPeriod;
    }
}
