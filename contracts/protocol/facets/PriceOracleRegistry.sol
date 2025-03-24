// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FermionStorage } from "../libs/Storage.sol";
import { Access } from "../bases/mixins/Access.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IPriceOracleRegistry } from "../interfaces/IPriceOracleRegistry.sol";
import { ADMIN } from "../domain/Constants.sol";

/**
 * @title PriceOracleRegistryFacet
 * @dev Manages a registry of approved price oracles for RWAs within the protocol, with admin restrictions.
 */
contract PriceOracleRegistryFacet is Access, FermionErrors, IPriceOracleRegistry {
    /**
     * @notice Adds a new Price Oracle to the registry.
     *
     * Emits a `PriceOracleAdded` event if successful.
     *
     * Reverts if:
     * - The caller is not an admin.
     * - The oracle address is zero.
     * - The identifier is empty.
     * - The oracle address is already approved.
     * - The oracle does not comply with `IPriceOracle`.
     * - The oracle's `getPrice` method reverts or returns zero.
     *
     * @param oracleAddress The address of the oracle to add.
     * @param identifier A simple identifier (e.g., "GOLD" or "REAL_ESTATE") for the associated RWA.
     */
    function addPriceOracle(address oracleAddress, bytes32 identifier) external onlyRole(ADMIN) {
        FermionStorage.PriceOracleRegistryStorage storage registry = FermionStorage.priceOracleRegistryStorage();

        if (oracleAddress == address(0)) {
            revert InvalidAddress();
        }
        if (identifier == bytes32(0)) {
            revert InvalidIdentifier();
        }
        if (registry.priceOracles[oracleAddress] != bytes32(0)) {
            revert OracleAlreadyApproved();
        }

        try IPriceOracle(oracleAddress).getPrice() returns (uint256 price) {
            if (price == 0) {
                revert OracleReturnedInvalidPrice();
            }
        } catch {
            revert OracleValidationFailed();
        }

        registry.priceOracles[oracleAddress] = identifier;

        emit PriceOracleAdded(oracleAddress, identifier);
    }

    /**
     * @notice Removes an existing Price Oracle from the registry.
     *
     * Emits a `PriceOracleRemoved` event if successful.
     *
     * Reverts if:
     * - The caller is not an admin.
     * - The oracle address is not approved.
     *
     * @param oracleAddress The address of the oracle to remove.
     */
    function removePriceOracle(address oracleAddress) external onlyRole(ADMIN) {
        FermionStorage.PriceOracleRegistryStorage storage registry = FermionStorage.priceOracleRegistryStorage();

        if (registry.priceOracles[oracleAddress] == bytes32(0)) {
            revert OracleNotApproved();
        }

        delete registry.priceOracles[oracleAddress];
        emit PriceOracleRemoved(oracleAddress);
    }

    /**
     * @notice Checks if a Price Oracle is approved in the registry.
     * @param oracleAddress The address of the oracle to check.
     * @return True if the oracle is approved, false otherwise.
     */
    function isPriceOracleApproved(address oracleAddress) external view returns (bool) {
        return FermionStorage.priceOracleRegistryStorage().priceOracles[oracleAddress] != bytes32(0);
    }

    /**
     * @notice Fetches the identifier associated with a Price Oracle.
     * @param oracleAddress The address of the oracle.
     * @return The identifier of the associated RWA, or zero if not found.
     */
    function getPriceOracleIdentifier(address oracleAddress) external view returns (bytes32) {
        return FermionStorage.priceOracleRegistryStorage().priceOracles[oracleAddress];
    }
}
