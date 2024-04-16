// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { IEntityEvents } from "../interfaces/events/IEntityEvents.sol";

/**
 * @title EntityFacet
 *
 * @notice Handles entity management.
 */
contract EntityFacet is FermionErrors {
    uint256 private constant TOTAL_ROLE_COUNT = uint256(type(FermionTypes.EntityRole).max) + 1;
    uint256 private constant ENTITY_ROLE_MASK = (1 << TOTAL_ROLE_COUNT) - 1;

    /**
     * @notice Creates an entity.
     *
     * Emits an EntityUpdated event if successful.
     *
     * Reverts if:
     * - No role is specified
     * - Entity exists already
     *
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function createEntity(FermionTypes.EntityRole[] calldata _roles, string calldata _metadata) external {
        if (_roles.length == 0) revert InvalidEntityRoles();

        FermionTypes.EntityData storage newEntity = FermionStorage.protocolEntities().entity[msg.sender];

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
     *
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function updateEntity(FermionTypes.EntityRole[] calldata _roles, string calldata _metadata) external {
        FermionTypes.EntityData storage newEntity = FermionStorage.protocolEntities().entity[msg.sender];

        if (newEntity.roles == 0) revert NoSuchEntity();

        storeEntity(newEntity, _roles, _metadata);
    }

    /**
     * @notice Gets the details about the entity.
     *
     * @param _entityAddres - the address of the entity
     * @return roles - the roles the entity has
     * @return metadataURI - the metadata URI for the entity
     */
    function getEntity(
        address _entityAddres
    ) external view returns (FermionTypes.EntityRole[] memory roles, string memory metadataURI) {
        FermionTypes.EntityData storage entity = FermionStorage.protocolEntities().entity[_entityAddres];
        uint256 compactRole = entity.roles;
        metadataURI = entity.metadataURI;

        // max number of roles an entity can have
        roles = new FermionTypes.EntityRole[](TOTAL_ROLE_COUNT);

        // Return the roles
        if (compactRole == ENTITY_ROLE_MASK) {
            for (uint256 i = 0; i < TOTAL_ROLE_COUNT; i++) {
                roles[i] = FermionTypes.EntityRole(i);
            }
        } else {
            uint256 count = 0;
            for (uint256 i = 0; i < TOTAL_ROLE_COUNT; i++) {
                // Check if the entity has role by bitwise AND operation with shifted 1
                if (compactRole & (1 << i) != 0) {
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
     * @notice Write entity data in the storage.
     *
     * Emits an EntityUpdated event if successful.
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
        // Calculate the compact role as the sum of individual regions
        // Use "or" to get the correct value even if the same region is specified more than once
        uint256 compactRole;
        for (uint256 i = 0; i < _roles.length; i++) {
            // Get enum value as power of 2
            uint256 role = 1 << uint256(_roles[i]);
            compactRole |= role;
        }

        _entityData.roles = compactRole;
        _entityData.metadataURI = _metadata;

        // Notify watchers of state change
        emit IEntityEvents.EntityUpdated(msg.sender, _roles, _metadata);
    }
}
