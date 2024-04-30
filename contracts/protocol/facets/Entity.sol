// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Context } from "../libs/Context.sol";
import { IEntityEvents } from "../interfaces/events/IEntityEvents.sol";

/**
 * @title EntityFacet
 *
 * @notice Handles entity management.
 */
contract EntityFacet is Context, FermionErrors, IEntityEvents {
    uint256 private constant TOTAL_ROLE_COUNT = uint256(type(FermionTypes.EntityRole).max) + 1;
    uint256 private constant ENTITY_ROLE_MASK = (1 << TOTAL_ROLE_COUNT) - 1;
    // uint8 constant private ROLE_PERMISSION_MASK = 0xFF;
    uint8 private constant ROLE_PERMISSION_MASK =
        (uint8(1) << (uint8(type(FermionTypes.EntityActor).max) + uint8(1))) - 1;

    /**
     * @notice Creates an entity.
     *
     * Emits an EntityStored event if successful.
     *
     * Reverts if:
     * - Entity exists already
     * - No role is specified
     *
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function createEntity(FermionTypes.EntityRole[] calldata _roles, string calldata _metadata) external {
        address msgSender = msgSender();
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = pl.entityId[msgSender];
        if (entityId != 0) revert EntityAlreadyExists();

        entityId = ++pl.entityCounter;
        pl.entityId[msgSender] = entityId;
        FermionTypes.EntityData storage newEntity = FermionStorage.protocolEntities().entityData[entityId];

        storeEntity(newEntity, _roles, _metadata);
    }

    /**
     * @notice Add entity actors.
     *
     * Each address can have multiple actor roles from FermionTypes.EntityActor
     * For each role that the entity has, the permissions are set independently.
     *
     * @param _actorWallets - list of wallets that acts on the seller's behalf
     * @param _actorRoles - list of corresponding roles, for which the address is given a certain permission. If actorRoles[i] is empty, the address is given the permissions for all roles.
     * @param _actorPermissions - list of permissions for each wallet and role
     */
    function addEntityActors(
        address[] calldata _actorWallets,
        FermionTypes.EntityRole[][] calldata _actorRoles,
        FermionTypes.EntityActor[][][] calldata _actorPermissions
    ) external {
        if (_actorWallets.length != _actorRoles.length)
            revert ArrayLengthMismatch(_actorWallets.length, _actorRoles.length);
        if (_actorWallets.length != _actorPermissions.length)
            revert ArrayLengthMismatch(_actorWallets.length, _actorPermissions.length);

        // address msgSender = msgSender();
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = pl.entityId[msgSender()];
        if (entityId == 0) revert NoSuchEntity();

        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();

        uint256 compactEntityRoles = pe.entityData[entityId].roles;
        for (uint256 i = 0; i < _actorWallets.length; i++) {
            address actorWallet = _actorWallets[i];
            uint256 actorId = pl.actorId[actorWallet];

            if (actorId == 0) {
                actorId = ++pl.actorsCounter;
                pl.actorId[actorWallet] = actorId;
            }

            mapping(uint256 => uint256) storage actorPermissions = pe.actorPermissions[entityId];
            uint256 compactActorPermissions;

            if (_actorRoles[i].length == 0) {
                uint8 compactPermissionPerRole = actorPermissionsToCompactPermissions(_actorPermissions[i][0]);
                uint256 role = compactPermissionPerRole << (31 * 8); // put in the first byte. 8 bits of permissions for each role
                compactActorPermissions |= role;
            } else {
                for (uint256 j = 0; j < _actorRoles[i].length; j++) {
                    FermionTypes.EntityRole actorRole = _actorRoles[i][j];
                    // Check that the entity has the role
                    if (compactEntityRoles & (1 << uint256(actorRole)) == 0) {
                        revert EntityHasNoRole(entityId, actorRole);
                    }

                    uint8 compactPermissionPerRole = actorPermissionsToCompactPermissions(_actorPermissions[i][j]);
                    uint256 role = compactPermissionPerRole << uint8(uint256(actorRole) * 8); // 8 bits of permissions for each role
                    compactActorPermissions |= role;
                }
            }

            actorPermissions[entityId] |= compactActorPermissions;
        }
    }

    /**
     * @notice Tells if a wallet has a specific permission for entity id and its role.
     *
     * @param _actorAddress - the address of the wallet
     * @param _entityId - the entity ID
     * @param _role - the role of the entity
     * @param _actor - the permission
     */
    function hasRole(
        address _actorAddress,
        uint256 _entityId,
        FermionTypes.EntityRole _role,
        FermionTypes.EntityActor _actor
    ) external view returns (bool) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 actorId = pl.actorId[_actorAddress];
        if (actorId == 0) return false;

        uint256 compactActorPermissions = FermionStorage.protocolEntities().actorPermissions[actorId][_entityId];

        uint256 permission = 1 << uint256(_actor);
        uint256 entityWidePermission = compactActorPermissions >> (31 * 8);
        uint256 roleSpecificPermission = compactActorPermissions >> (uint256(_role) * 8);
        return (entityWidePermission & permission != 0) || (roleSpecificPermission & permission != 0);
    }

    /**
     * @notice Accept the admin role for an entity.
     *
     * Emits an EntityActorAdded event if successful.
     *
     * Reverts if:
     * - Caller is not pending admin for the entity
     * - Caller is already an admin for another entity
     *
     * @param _entityId - the entity ID
     */
    function acceptAdminRole(uint256 _entityId) public {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        address msgSender = msgSender();

        if (!pl.pendingAdminEntity[_entityId][msgSender]) revert NotPendingAdmin(_entityId, msgSender);
        if (pl.entityId[msgSender] != 0) revert AlreadyAdmin(_entityId, msgSender);

        delete pl.pendingAdminEntity[_entityId][msgSender];
        pl.entityId[msgSender] = _entityId;

        FermionTypes.EntityActor[] memory adminActor = new FermionTypes.EntityActor[](1);
        adminActor[0] = FermionTypes.EntityActor.Admin;
        emit EntityActorAdded(_entityId, msgSender, new FermionTypes.EntityRole[](0), adminActor);
    }

    /**
     * @notice Updates an entity.
     *
     * Emits an EntityStored event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     * - No role is specified
     *
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function updateEntity(FermionTypes.EntityRole[] calldata _roles, string calldata _metadata) external {
        FermionTypes.EntityData storage entityData = fetchEntityData(msgSender());

        storeEntity(entityData, _roles, _metadata);
    }

    /**
     * @notice Deletes an entity.
     *
     * Emits an EntityStored event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     *
     */
    function deleteEntity() external {
        address entityAddress = msgSender();
        FermionTypes.EntityData storage entityData = fetchEntityData(entityAddress);

        delete entityData.roles;
        delete entityData.metadataURI;
        delete FermionStorage.protocolLookups().entityId[entityAddress];

        emit EntityStored(entityAddress, new FermionTypes.EntityRole[](0), "");
    }

    /**
     * @notice Gets the details about the entity.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _entityAddres - the address of the entity
     * @return roles - the roles the entity has
     * @return metadataURI - the metadata URI for the entity
     */
    function getEntity(
        address _entityAddres
    ) external view returns (FermionTypes.EntityRole[] memory roles, string memory metadataURI) {
        FermionTypes.EntityData storage entityData = fetchEntityData(_entityAddres);

        roles = compactRoleToRoles(entityData.roles);
        metadataURI = entityData.metadataURI;
    }

    /**
     * @notice Write entity data in the storage.
     *
     * Emits an EntityStored event if successful.
     *
     * Reverts if:
     * - No role is specified
     *
     * @param _entityData - storage pointer to data location
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function storeEntity(
        FermionTypes.EntityData storage _entityData,
        FermionTypes.EntityRole[] calldata _roles,
        string calldata _metadata
    ) internal {
        if (_roles.length == 0) revert InvalidEntityRoles();

        _entityData.roles = rolesToCompactRole(_roles);
        _entityData.metadataURI = _metadata;

        // Notify watchers of state change
        emit EntityStored(msgSender(), _roles, _metadata);
    }

    /**
     * @notice Gets the entity data from the storage.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _entityAddress - the address of the entity
     * @return entityData -  storage pointer to data location
     */
    function fetchEntityData(
        address _entityAddress
    ) internal view returns (FermionTypes.EntityData storage entityData) {
        uint256 entityId = FermionStorage.protocolLookups().entityId[_entityAddress];
        if (entityId == 0) revert NoSuchEntity();

        entityData = FermionStorage.protocolEntities().entityData[entityId];
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
    function rolesToCompactRole(FermionTypes.EntityRole[] calldata _roles) internal pure returns (uint256 compactRole) {
        for (uint256 i = 0; i < _roles.length; i++) {
            // Get enum value as power of 2
            uint256 role = 1 << uint256(_roles[i]);
            compactRole |= role;
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
     * @notice Converts array of Permisions to compact permission.
     *
     * Calculates the compact permission as the sum of individual permission.
     * Use "or" to get the correct value even if the same role is specified more than once.
     *
     * @param _actorPermissions - the array of permissions
     * @return compactPermissionPerRole - the compact representation of permissions
     */
    function actorPermissionsToCompactPermissions(
        FermionTypes.EntityActor[] calldata _actorPermissions
    ) internal pure returns (uint8 compactPermissionPerRole) {
        if (_actorPermissions.length == 0) {
            return ROLE_PERMISSION_MASK;
        }

        for (uint256 i = 0; i < _actorPermissions.length; i++) {
            uint8 permission = uint8(1) << uint8(_actorPermissions[i]);
            compactPermissionPerRole |= permission;
        }
    }
}
