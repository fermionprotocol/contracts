// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { BYTE_SIZE } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { FermionErrors } from "../domain/Errors.sol";

/**
 * @title EntityLib
 *
 * @notice Entity methods used by multiple facets.
 */
library EntityLib {
    /**
     * @notice Tells if a wallet has a specific wallet role for entity id and its role.
     *
     * @param _entityId - the entity ID
     * @param _walletAddress - the address of the wallet
     * @param _entityRole - the role of the entity
     * @param _walletRole - the wallet role
     * @param _requireEntityWide - if true, the wallet must have the role entity-wide
     */
    function hasWalletRole(
        uint256 _entityId,
        address _walletAddress,
        FermionTypes.EntityRole _entityRole,
        FermionTypes.WalletRole _walletRole,
        bool _requireEntityWide
    ) internal view returns (bool) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        validateEntityId(_entityId, pl);

        uint256 walletId = pl.walletId[_walletAddress];

        if (walletId == 0) return false;

        uint256 compactWalletRole = FermionStorage.protocolEntities().walletRole[walletId][_entityId];
        uint256 walletRole = 1 << uint256(_walletRole);
        uint256 entityWidePermission = compactWalletRole >> (31 * BYTE_SIZE);

        return
            (entityWidePermission & walletRole != 0) ||
            (!_requireEntityWide && hasWalletRoleSpecificPermission(_entityRole, walletRole, compactWalletRole));
    }

    function hasWalletRoleSpecificPermission(
        FermionTypes.EntityRole _entityRole,
        uint256 _walletRole,
        uint256 _compactWalletRole
    ) internal pure returns (bool) {
        uint256 roleSpecificPermission = _compactWalletRole >> (uint256(_entityRole) * BYTE_SIZE);
        return roleSpecificPermission & _walletRole != 0;
    }

    /**
     * @notice  Reverts if wallet does not have the role
     *
     * @param _entityId - the entity ID
     * @param _walletAddress - the address of the wallet
     * @param _entityRole - the role to check
     * @param _walletRole - the wallet role to check
     */
    function validateWalletRole(
        uint256 _entityId,
        address _walletAddress,
        FermionTypes.EntityRole _entityRole,
        FermionTypes.WalletRole _walletRole
    ) internal view {
        if (!hasWalletRole(_entityId, _walletAddress, _entityRole, _walletRole, false)) {
            revert FermionErrors.WalletHasNoRole(_entityId, _walletAddress, _entityRole, _walletRole);
        }
    }

    /**
     * @notice  Reverts if entity does not have the role
     *
     * @param _entityId - the entity ID
     * @param _compactEntityRoles - the compact representation of entity roles
     * @param _entityRole - the role to check
     */
    function validateEntityRole(
        uint256 _entityId,
        uint256 _compactEntityRoles,
        FermionTypes.EntityRole _entityRole
    ) internal pure {
        if (!checkEntityRole(_compactEntityRoles, _entityRole)) {
            revert FermionErrors.EntityHasNoRole(_entityId, _entityRole);
        }
    }

    /**
     * @notice  Checks if entity has the role
     *
     * @param _compactEntityRoles - the compact representation of entity roles
     * @param _entityRole - the role to check
     */
    function checkEntityRole(
        uint256 _compactEntityRoles,
        FermionTypes.EntityRole _entityRole
    ) internal pure returns (bool) {
        return _compactEntityRoles & (1 << uint256(_entityRole)) != 0;
    }

    /** @notice Reverts if the entity ID is invalid
     *
     * @param _entityId - the entity ID
     * @param pl - the protocol lookups
     */
    function validateEntityId(uint256 _entityId, FermionStorage.ProtocolLookups storage pl) internal view {
        if (_entityId == 0 || _entityId > pl.entityCounter) revert FermionErrors.NoSuchEntity(_entityId);
    }
}
