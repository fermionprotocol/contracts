// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionErrors } from "../../protocol/domain/Errors.sol";
import { ADMIN, PAUSER, UPGRADER, FEE_COLLECTOR } from "../../protocol/domain/Constants.sol";
import { AccessControlUpgradeable as AccessControl } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { Context } from "../../protocol/bases/mixins/Context.sol";

/**
 * @title AccessController
 *
 * @notice Implements centralized role-based access for Boson Protocol contracts.
 */
contract AccessController is AccessControl, Context, FermionErrors {
    address private immutable THIS_ADDRESS = address(this); // used to prevent invocation of 'initialize' directly on deployed contract. Variable is not used by the protocol.

    /**
     * @notice Initialize
     *
     * Grants ADMIN role to the provided address.
     * Sets ADMIN as role admin for all other roles.
     *
     * @param _defaultAdmin - the address to grant the ADMIN role to
     */
    function initialize(address _defaultAdmin) external initializer {
        if (address(this) == THIS_ADDRESS) revert DirectInitializationNotAllowed();
        if (_defaultAdmin == address(0)) revert InvalidAddress();

        __AccessControl_init();

        _grantRole(ADMIN, _defaultAdmin);
        _setRoleAdmin(ADMIN, ADMIN);
        _setRoleAdmin(PAUSER, ADMIN);
        _setRoleAdmin(UPGRADER, ADMIN);
        _setRoleAdmin(FEE_COLLECTOR, ADMIN);
    }

    function _msgSender() internal view virtual override(Context, ContextUpgradeable) returns (address) {
        return Context._msgSender();
    }
}
