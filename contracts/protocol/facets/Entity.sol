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
contract EntityFacet is Context, FermionErrors {
    uint256 private constant TOTAL_ROLE_COUNT = uint256(type(FermionTypes.EntityRole).max) + 1;
    uint256 private constant ENTITY_ROLE_MASK = (1 << TOTAL_ROLE_COUNT) - 1;

    /**
     * @notice Creates an entity.
     *
     * Emits an EntityUpdated event if successful.
     *
     * Reverts if:
     * - Entity exists already
     * - No role is specified
     *
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function createEntity(FermionTypes.EntityRole[] calldata _roles, string calldata _metadata) external {
        FermionTypes.EntityData storage newEntity = FermionStorage.protocolEntities().entityData[msgSender()];

        if (newEntity.roles != 0) revert EntityAlreadyExists();

        storeEntity(newEntity, _roles, _metadata);
    }

    /**
     * @notice Updates an entity.
     *
     * Emits an EntityUpdated event if successful.
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
     * Emits an EntityUpdated event if successful.
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

        emit IEntityEvents.EntityUpdated(entityAddress, new FermionTypes.EntityRole[](0), "");
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
     * Emits an EntityUpdated event if successful.
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
        emit IEntityEvents.EntityUpdated(msgSender(), _roles, _metadata);
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
        entityData = FermionStorage.protocolEntities().entityData[_entityAddress];

        if (entityData.roles == 0) revert NoSuchEntity();
    }

    /**
     * @notice Converts array of Roles to compact roles.
     *
     * Calculates the compact role as the sum of individual regions.
     * Use "or" to get the correct value even if the same region is specified more than once.
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
}
