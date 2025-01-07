// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPriceOracleRegistry
 * @dev Interface for the PriceOracleRegistry contract.
 */
interface IPriceOracleRegistry {
    /**
     * @notice Adds a new Price Oracle to the registry.
     * @param oracleAddress The address of the oracle to add.
     * @param identifier A simple identifier (e.g., "GOLD" or "REAL_ESTATE") for the associated RWA.
     */
    function addPriceOracle(address oracleAddress, bytes32 identifier) external;

    /**
     * @notice Removes an existing Price Oracle from the registry.
     * @param oracleAddress The address of the oracle to remove.
     */
    function removePriceOracle(address oracleAddress) external;

    /**
     * @notice Checks if a Price Oracle is approved in the registry.
     * @param oracleAddress The address of the oracle to check.
     * @return True if the oracle is approved, false otherwise.
     */
    function isPriceOracleApproved(address oracleAddress) external view returns (bool);

    /**
     * @notice Fetches the identifier associated with a Price Oracle.
     * @param oracleAddress The address of the oracle.
     * @return The identifier of the associated RWA, or zero if not found.
     */
    function getPriceOracleIdentifier(address oracleAddress) external view returns (bytes32);
}
