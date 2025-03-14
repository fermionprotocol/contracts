// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { BYTE_SIZE } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { EntityErrors } from "../domain/Errors.sol";
import { IEntityEvents } from "../interfaces/events/IEntityEvents.sol";
import { ContextLib } from "../libs/Context.sol";

/**
 * @title EntityLib
 *
 * @notice Entity methods used by multiple facets.
 */
library EntityLib {
    uint256 private constant TOTAL_ROLE_COUNT = uint256(type(FermionTypes.EntityRole).max) + 1;
    uint256 private constant ENTITY_ROLE_MASK = (1 << TOTAL_ROLE_COUNT) - 1;

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
    ) internal returns (uint256 entityId) {
        entityId = ++pl.entityCounter;
        pl.entityId[_admin] = entityId;
        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();
        FermionTypes.EntityData storage newEntity = pe.entityData[entityId];

        storeEntity(entityId, _admin, newEntity, _roles, _metadata);
        storeCompactAccountRole(entityId, _admin, 0xff << (31 * BYTE_SIZE), true, pl, pe); // compact role for all current and potential future roles
        emitManagerAccountAddedOrRemoved(entityId, _admin, true);
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
        if (_admin == address(0)) {
            _admin = _entityData.admin; // covers updateEntity case
        } else {
            _entityData.admin = _admin;
        }
        _entityData.roles = rolesToCompactRole(_roles);
        _entityData.metadataURI = _metadata;

        // Notify watchers of state change
        emit IEntityEvents.EntityStored(_entityId, _admin, _roles, _metadata);
    }

    /**
     * @notice Stores compact account role for the entity and account.
     *
     * @param _entityId - the entity ID
     * @param _account - the account address
     * @param _compactAccountRole - the compact account role
     * @param _add - if true, the account is added, if false, it is removed
     * @param pl - the protocol lookups storage
     * @param pe - the protocol entities storage
     */
    function storeCompactAccountRole(
        uint256 _entityId,
        address _account,
        uint256 _compactAccountRole,
        bool _add,
        FermionStorage.ProtocolLookups storage pl,
        FermionStorage.ProtocolEntities storage pe
    ) internal {
        uint256 accountId = pl.accountId[_account];

        if (accountId == 0) {
            accountId = ++pl.accountsCounter;
            pl.accountId[_account] = accountId;
        }

        if (_add) {
            pe.accountRole[accountId][_entityId] |= _compactAccountRole;
        } else {
            pe.accountRole[accountId][_entityId] &= ~_compactAccountRole;
        }
    }

    /**
     * @notice Creates event arguments and emits EntityAccountAdded, when entity-wide manager is added or removed.
     *
     * @param _entityId - the entity ID
     * @param _account - the admin account address
     * @param _added - if true, the account is added, if false, it is removed
     */
    function emitManagerAccountAddedOrRemoved(uint256 _entityId, address _account, bool _added) internal {
        FermionTypes.AccountRole[][] memory adminAccount = new FermionTypes.AccountRole[][](1);
        adminAccount[0] = new FermionTypes.AccountRole[](1);
        adminAccount[0][0] = FermionTypes.AccountRole.Manager;
        if (_added) {
            emit IEntityEvents.EntityAccountAdded(_entityId, _account, new FermionTypes.EntityRole[](0), adminAccount);
        } else {
            emit IEntityEvents.EntityAccountRemoved(
                _entityId,
                _account,
                new FermionTypes.EntityRole[](0),
                adminAccount
            );
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
        for (uint256 i; i < _roles.length; ++i) {
            // Get enum value as power of 2
            compactRole |= (1 << uint256(_roles[i]));
        }
    }

    /**
     * @notice Converts compact role to array of Roles.
     *
     * @param _compactRole - the compact representation of roles
     * @return roles - the array of roles
     */
    function compactRoleToRoles(uint256 _compactRole) internal pure returns (FermionTypes.EntityRole[] memory roles) {
        // max number of roles an entity can have
        roles = new FermionTypes.EntityRole[](TOTAL_ROLE_COUNT);

        // Return the roles
        if (_compactRole == ENTITY_ROLE_MASK) {
            for (uint256 i = 0; i < TOTAL_ROLE_COUNT; i++) {
                roles[i] = FermionTypes.EntityRole(i);
            }
        } else {
            uint256 count = 0;
            for (uint256 i = 0; i < TOTAL_ROLE_COUNT; i++) {
                // Check if the entity has role by bitwise AND operation with shifted 1
                if (_compactRole & (1 << i) != 0) {
                    roles[count] = FermionTypes.EntityRole(i);
                    count++;
                }
            }

            // setting the correct number of roles
            assembly {
                mstore(roles, count)
            }
        }
    }

    /**
     * @notice Tells if a account has a specific account role for entity id and its role.
     *
     * @param _entityId - the entity ID
     * @param _accountAddress - the address of the account
     * @param _entityRole - the role of the entity
     * @param _accountRole - the account role
     * @param _requireEntityWide - if true, the account must have the role entity-wide
     */
    function hasAccountRole(
        uint256 _entityId,
        address _accountAddress,
        FermionTypes.EntityRole _entityRole,
        FermionTypes.AccountRole _accountRole,
        bool _requireEntityWide
    ) internal view returns (bool) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        validateEntityId(_entityId, pl);

        uint256 accountId = pl.accountId[_accountAddress];

        if (accountId == 0) return false;

        uint256 compactAccountRole = FermionStorage.protocolEntities().accountRole[accountId][_entityId];
        uint256 accountRole = 1 << uint256(_accountRole);
        uint256 entityWidePermission = compactAccountRole >> (31 * BYTE_SIZE);

        return
            (entityWidePermission & accountRole != 0) ||
            (!_requireEntityWide && hasAccountRoleSpecificPermission(_entityRole, accountRole, compactAccountRole));
    }

    function hasAccountRoleSpecificPermission(
        FermionTypes.EntityRole _entityRole,
        uint256 _accountRole,
        uint256 _compactAccountRole
    ) internal pure returns (bool) {
        uint256 roleSpecificPermission = _compactAccountRole >> (uint256(_entityRole) * BYTE_SIZE);
        return roleSpecificPermission & _accountRole != 0;
    }

    /**
     * @notice  Reverts if account does not have the role
     *
     * @param _entityId - the entity ID
     * @param _accountAddress - the address of the account
     * @param _entityRole - the role to check
     * @param _accountRole - the account role to check
     */
    function validateAccountRole(
        uint256 _entityId,
        address _accountAddress,
        FermionTypes.EntityRole _entityRole,
        FermionTypes.AccountRole _accountRole
    ) internal view {
        if (!hasAccountRole(_entityId, _accountAddress, _entityRole, _accountRole, false)) {
            revert EntityErrors.AccountHasNoRole(_entityId, _accountAddress, _entityRole, _accountRole);
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
            revert EntityErrors.EntityHasNoRole(_entityId, _entityRole);
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

    /**
     * @notice Gets the entity data from the storage.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _adminAccount - the address of the entity's admin
     * @return entityId - the entity ID
     * @return entityData -  storage pointer to data location
     */
    function fetchEntityData(
        address _adminAccount
    ) internal view returns (uint256 entityId, FermionTypes.EntityData storage entityData) {
        entityId = FermionStorage.protocolLookups().entityId[_adminAccount];
        if (entityId == 0) revert EntityErrors.NoSuchEntity(0);

        entityData = FermionStorage.protocolEntities().entityData[entityId];
    }

    /**
     * @notice Gets the entity data from the storage.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _entityId - the entity ID
     * @return entityData -  storage pointer to data location
     */
    function fetchEntityData(uint256 _entityId) internal view returns (FermionTypes.EntityData storage entityData) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        validateEntityId(_entityId, pl);

        entityData = FermionStorage.protocolEntities().entityData[_entityId];
    }

    /** @notice Reverts if the entity ID is invalid
     *
     * @param _entityId - the entity ID
     * @param pl - the protocol lookups
     */
    function validateEntityId(uint256 _entityId, FermionStorage.ProtocolLookups storage pl) internal view {
        if (_entityId == 0 || _entityId > pl.entityCounter) revert EntityErrors.NoSuchEntity(_entityId);
    }

    /** @notice Verifies that the caller is either a seller's assistant or seller's facilitator's assistant
     *
     * @param _sellerId - the seller's entity ID
     * @param _facilitatorId - the facilitator's entity ID
     */
    function validateSellerAssistantOrFacilitator(uint256 _sellerId, uint256 _facilitatorId) internal view {
        validateSellerAssistantOrFacilitator(_sellerId, _facilitatorId, ContextLib._msgSender());
    }

    /** @notice Verifies that the caller is either a seller's assistant or seller's facilitator's assistant
     *
     * @param _sellerId - the seller's entity ID
     * @param _facilitatorId - the facilitator's entity ID
     * @param _accountAddress - the address of the account
     */
    function validateSellerAssistantOrFacilitator(
        uint256 _sellerId,
        uint256 _facilitatorId,
        address _accountAddress
    ) internal view {
        if (
            !hasAccountRole(
                _sellerId,
                _accountAddress,
                FermionTypes.EntityRole.Seller,
                FermionTypes.AccountRole.Assistant,
                false
            ) &&
            !hasAccountRole(
                _facilitatorId,
                _accountAddress,
                FermionTypes.EntityRole.Seller,
                FermionTypes.AccountRole.Assistant,
                false
            )
        ) {
            revert EntityErrors.AccountHasNoRole(
                _sellerId,
                _accountAddress,
                FermionTypes.EntityRole.Seller,
                FermionTypes.AccountRole.Assistant
            );
        }
    }

    /** @notice Returns the entity id for the account address. If the entity not exist, it creates one with the provided role.
     * If the entity exists, but does not have the role, it adds the role to the entity.
     *
     * @param _entityAddress - the entity's address
     * @param _role - the entity's role
     * @param pl - the protocol lookups storage
     * @return entityId - the entity's id
     */
    function getOrCreateEntityId(
        address _entityAddress,
        FermionTypes.EntityRole _role,
        FermionStorage.ProtocolLookups storage pl
    ) internal returns (uint256 entityId) {
        entityId = pl.entityId[_entityAddress];

        if (entityId == 0) {
            FermionTypes.EntityRole[] memory _roles = new FermionTypes.EntityRole[](1);
            _roles[0] = _role;
            entityId = createEntity(_entityAddress, _roles, "", pl);
        } else {
            FermionTypes.EntityData storage entityData = FermionStorage.protocolEntities().entityData[entityId];
            uint256 compactEntityRoles = entityData.roles;
            if (!checkEntityRole(compactEntityRoles, _role)) {
                compactEntityRoles |= (1 << uint256(_role));
                FermionStorage.protocolEntities().entityData[entityId].roles = compactEntityRoles;
                emit IEntityEvents.EntityStored(
                    entityId,
                    _entityAddress,
                    compactRoleToRoles(compactEntityRoles),
                    entityData.metadataURI
                );
            }
        }
    }
}
