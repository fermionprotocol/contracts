// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPriceOracleRegistryEvents
 * @notice Defines events related to PriceOracleRegistry.
 */
interface IPriceOracleRegistryEvents {
    event PriceOracleAdded(address indexed oracleAddress, bytes32 identifier);
    event PriceOracleRemoved(address indexed oracleAddress);
}
