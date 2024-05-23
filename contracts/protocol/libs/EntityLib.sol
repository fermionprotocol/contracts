// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { BYTE_SIZE } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { IEntityEvents } from "../interfaces/events/IEntityEvents.sol";
import { ContextLib } from "./Context.sol";

/**
 * @title EntityLib
 *
 * @notice Entity methods used by multiple facets.
 */
library EntityLib {
    /**
     * @notice Creates an entity.
     *
     * Emits an EntityStored event if successful.
     *
     * @param _admin - the admin address of the entity
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     * @param pl - the protocol lookups storage
     */
    function createEntity(
        address _admin,
        FermionTypes.EntityRole[] memory _roles,
        string memory _metadata,
        FermionStorage.ProtocolLookups storage pl
    ) internal {
        uint256 entityId = ++pl.entityCounter;
        pl.entityId[_admin] = entityId;
        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();
        FermionTypes.EntityData storage newEntity = pe.entityData[entityId];

        EntityLib.storeEntity(entityId, _admin, newEntity, _roles, _metadata);
        storeCompactWalletRole(entityId, _admin, 0xff << (31 * BYTE_SIZE), true, pl, pe); // compact role for all current and potential future roles
        emitAdminWalletAddedOrRemoved(entityId, _admin, true);
    }

    /**
     * @notice Write entity data in the storage.
     *
     * Emits an EntityStored event if successful.
     *
     * @param _entityId - the entity ID
     * @param _admin - the address of the entity
     * @param _entityData - storage pointer to data location
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function storeEntity(
        uint256 _entityId,
        address _admin,
        FermionTypes.EntityData storage _entityData,
        FermionTypes.EntityRole[] memory _roles,
        string memory _metadata
    ) internal {
        if (_admin != address(0)) {
            _entityData.admin = _admin;
        }
        _entityData.roles = rolesToCompactRole(_roles);
        _entityData.metadataURI = _metadata;

        // Notify watchers of state change
        emit IEntityEvents.EntityStored(_entityId, ContextLib.msgSender(), _roles, _metadata);
    }

    /**
     * @notice Stores compact wallet role for the entity and wallet.
     *
     * @param _entityId - the entity ID
     * @param _wallet - the wallet address
     * @param _compactWalletRole - the compact wallet role
     * @param _add - if true, the wallet is added, if false, it is removed
     * @param pl - the protocol lookups storage
     * @param pe - the protocol entities storage
     */
    function storeCompactWalletRole(
        uint256 _entityId,
        address _wallet,
        uint256 _compactWalletRole,
        bool _add,
        FermionStorage.ProtocolLookups storage pl,
        FermionStorage.ProtocolEntities storage pe
    ) internal {
        uint256 walletId = pl.walletId[_wallet];

        if (walletId == 0) {
            walletId = ++pl.walletsCounter;
            pl.walletId[_wallet] = walletId;
        }

        if (_add) {
            pe.walletRole[walletId][_entityId] |= _compactWalletRole;
        } else {
            pe.walletRole[walletId][_entityId] &= ~_compactWalletRole;
        }
    }

    /**
     * @notice Creates event arguments and emits EntityWalletAdded, when entity-wide admin is added or removed.
     *
     * @param _entityId - the entity ID
     * @param _wallet - the admin wallet address
     * @param _added - if true, the wallet is added, if false, it is removed
     */
    function emitAdminWalletAddedOrRemoved(uint256 _entityId, address _wallet, bool _added) internal {
        FermionTypes.WalletRole[][] memory adminWallet = new FermionTypes.WalletRole[][](1);
        adminWallet[0] = new FermionTypes.WalletRole[](1);
        adminWallet[0][0] = FermionTypes.WalletRole.Admin;
        if (_added) {
            emit IEntityEvents.EntityWalletAdded(_entityId, _wallet, new FermionTypes.EntityRole[](0), adminWallet);
        } else {
            emit IEntityEvents.EntityWalletRemoved(_entityId, _wallet, new FermionTypes.EntityRole[](0), adminWallet);
        }
    }

    /**
     * @notice Converts array of Roles to compact roles.
     *
     * Calculates the compact role as the sum of individual roles.
     * Use "or" to get the correct value even if the same role is specified more than once.
     *
     * @param _roles - the array of roles
     * @return compactRole - the compact representation of roles
     */
    function rolesToCompactRole(FermionTypes.EntityRole[] memory _roles) internal pure returns (uint256 compactRole) {
        for (uint256 i = 0; i < _roles.length; i++) {
            // Get enum value as power of 2
            uint256 role = 1 << uint256(_roles[i]);
            compactRole |= role;
        }
    }

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
