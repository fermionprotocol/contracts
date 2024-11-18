// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../interfaces/IPriceOracle.sol";
import "../interfaces/IPriceOracleRegistry.sol";
import "../interfaces/events/IPriceOracleRegistryEvents.sol";

/**
 * @title PriceOracleRegistry
 * @dev Manages a registry of approved price oracles for RWAs, ensuring they comply with the IPriceOracle interface and return valid prices when added.
 */
contract PriceOracleRegistry is Initializable, OwnableUpgradeable, IPriceOracleRegistry, IPriceOracleRegistryEvents {
    /// @notice oracle address -> ID (e.g., "GOLD" or "REAL_ESTATE")
    mapping(address => bytes32) private priceOracles;

    /**
     * @notice Initializes the contract.
     * @param _owner The address of the owner.
     */
    function initialize(address _owner) external initializer {
        __Ownable_init(_owner);
    }

    /**
     * @notice Adds a new Price Oracle to the registry.
     *
     * Emits a `PriceOracleAdded` event if successful.
     *
     * Reverts if:
     * - The oracle address is zero.
     * - The identifier is empty.
     * - The oracle address is already approved.
     * - The oracle does not comply with `IPriceOracle`.
     * - The oracle's `getPrice` method reverts or returns zero.
     *
     * @param oracleAddress The address of the oracle to add.
     * @param identifier A simple identifier (e.g., "GOLD" or "REAL_ESTATE") for the associated RWA.
     */
    function addPriceOracle(address oracleAddress, bytes32 identifier) external onlyOwner {
        if (oracleAddress == address(0)) {
            revert InvalidOracleAddress();
        }
        if (identifier == bytes32(0)) {
            revert InvalidIdentifier();
        }
        if (priceOracles[oracleAddress] != bytes32(0)) {
            revert OracleAlreadyApproved();
        }

        try IPriceOracle(oracleAddress).getPrice() returns (uint256 price) {
            if (price == 0) {
                revert OracleReturnedInvalidPrice();
            }
        } catch {
            revert OracleValidationFailed();
        }

        priceOracles[oracleAddress] = identifier;

        emit PriceOracleAdded(oracleAddress, identifier);
    }

    /**
     * @notice Removes an existing Price Oracle from the registry.
     *
     * Emits a `PriceOracleRemoved` event if successful.
     *
     * Reverts if:
     * - The oracle address is not approved.
     *
     * @param oracleAddress The address of the oracle to remove.
     */
    function removePriceOracle(address oracleAddress) external onlyOwner {
        if (priceOracles[oracleAddress] == bytes32(0)) {
            revert OracleNotApproved();
        }

        delete priceOracles[oracleAddress];
        emit PriceOracleRemoved(oracleAddress);
    }

    /**
     * @notice Checks if a Price Oracle is approved in the registry.
     * @param oracleAddress The address of the oracle to check.
     * @return True if the oracle is approved, false otherwise.
     */
    function isPriceOracleApproved(address oracleAddress) external view returns (bool) {
        return priceOracles[oracleAddress] != bytes32(0);
    }

    /**
     * @notice Fetches the identifier associated with a Price Oracle.
     * @param oracleAddress The address of the oracle.
     * @return The identifier of the associated RWA, or zero if not found.
     */
    function getPriceOracleIdentifier(address oracleAddress) external view returns (bytes32) {
        return priceOracles[oracleAddress];
    }
}
