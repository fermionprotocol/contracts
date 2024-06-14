// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionErrors } from "../../protocol/domain/Errors.sol";
import { AccessControlUpgradeable as AccessControl } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/**
 * @title AccessController
 *
 * @notice Implements centralized role-based access for Boson Protocol contracts.
 */
contract AccessController is AccessControl {
    // Access Control Roles
    bytes32 private constant ADMIN = keccak256("ADMIN"); // Role Admin
    bytes32 private constant PAUSER = keccak256("PAUSER"); // Role for pausing the protocol
    bytes32 private constant UPGRADER = keccak256("UPGRADER"); // Role for performing contract and config upgrades
    bytes32 private constant FEE_COLLECTOR = keccak256("FEE_COLLECTOR"); // Role for collecting fees from the protocol

    /**
     * @notice Initialize
     *
     * Grants ADMIN role to the provided address.
     * Sets ADMIN as role admin for all other roles.
     *
     * @param _defaultAdmin - the address to grant the ADMIN role to
     */
    function initialize(address _defaultAdmin) external {
        if (_defaultAdmin == address(0)) revert FermionErrors.InvalidAddress();
        _grantRole(ADMIN, _defaultAdmin);
        _setRoleAdmin(ADMIN, ADMIN);
        _setRoleAdmin(PAUSER, ADMIN);
        _setRoleAdmin(UPGRADER, ADMIN);
        _setRoleAdmin(FEE_COLLECTOR, ADMIN);
    }
}
