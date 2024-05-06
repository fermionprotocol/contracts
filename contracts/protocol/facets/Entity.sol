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
        (uint8(1) << (uint8(type(FermionTypes.WalletRole).max) + uint8(1))) - 1;

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
     * @notice Add entity wallets.
     *
     * Each address can have multiple wallet roles from FermionTypes.WalletRole
     * For each role that the entity has, the wallet roles are set independently.
     *
     * @param _wallets - list of wallets that acts on the seller's behalf
     * @param _entityRoles - list of corresponding roles, for which the address is given a certain wallet role. If entityRoles[i] is empty, the address is given the wallet role to all entity roles.
     * @param _walletRole - list of wallet roles for each wallet and entity role
     */
    function addEntityWallets(
        address[] calldata _wallets,
        FermionTypes.EntityRole[][] calldata _entityRoles,
        FermionTypes.WalletRole[][][] calldata _walletRole
    ) external {
        if (_wallets.length != _entityRoles.length) revert ArrayLengthMismatch(_wallets.length, _entityRoles.length);
        if (_wallets.length != _walletRole.length) revert ArrayLengthMismatch(_wallets.length, _walletRole.length);

        // address msgSender = msgSender();
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = pl.entityId[msgSender()];
        if (entityId == 0) revert NoSuchEntity();

        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();

        uint256 compactEntityRoles = pe.entityData[entityId].roles;
        for (uint256 i = 0; i < _wallets.length; i++) {
            address wallet = _wallets[i];
            uint256 walletId = pl.walletId[wallet];

            if (walletId == 0) {
                walletId = ++pl.walletsCounter;
                pl.walletId[wallet] = walletId;
            }

            mapping(uint256 => uint256) storage walletRole = pe.walletRole[entityId];
            uint256 compactWalletRole;

            if (_entityRoles[i].length == 0) {
                uint8 compactWalletRolePerEntityRole = walletRoleToCompactWalletRoles(_walletRole[i][0]);
                uint256 role = compactWalletRolePerEntityRole << (31 * 8); // put in the first byte. 8 bits of wallet roles for each entity role
                compactWalletRole |= role;
            } else {
                for (uint256 j = 0; j < _entityRoles[i].length; j++) {
                    FermionTypes.EntityRole entityRole = _entityRoles[i][j];
                    // Check that the entity has the role
                    if (compactEntityRoles & (1 << uint256(entityRole)) == 0) {
                        revert EntityHasNoRole(entityId, entityRole);
                    }

                    uint8 compactWalletRolePerEntityRole = walletRoleToCompactWalletRoles(_walletRole[i][j]);
                    uint256 role = compactWalletRolePerEntityRole << uint8(uint256(entityRole) * 8); //8 bits of wallet roles for each entity role
                    compactWalletRole |= role;
                }
            }

            walletRole[entityId] |= compactWalletRole;
        }
    }

    /**
     * @notice Tells if a wallet has a specific wallet role for entity id and its role.
     *
     * @param _walletAddress - the address of the wallet
     * @param _entityId - the entity ID
     * @param _role - the role of the entity
     * @param _walletRole - the wallet role
     */
    function hasRole(
        address _walletAddress,
        uint256 _entityId,
        FermionTypes.EntityRole _role,
        FermionTypes.WalletRole _walletRole
    ) external view returns (bool) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 walletId = pl.walletId[_walletAddress];
        if (walletId == 0) return false;

        uint256 compactWalletRole = FermionStorage.protocolEntities().walletRole[walletId][_entityId];

        uint256 walletRole = 1 << uint256(_walletRole);
        uint256 entityWidePermission = compactWalletRole >> (31 * 8);
        uint256 roleSpecificPermission = compactWalletRole >> (uint256(_role) * 8);
        return (entityWidePermission & walletRole != 0) || (roleSpecificPermission & walletRole != 0);
    }

    /**
     * @notice Accept the admin role for an entity.
     *
     * Emits an EntityWalletAdded event if successful.
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

        FermionTypes.WalletRole[] memory adminWallet = new FermionTypes.WalletRole[](1);
        adminWallet[0] = FermionTypes.WalletRole.Admin;
        emit EntityWalletAdded(_entityId, msgSender, new FermionTypes.EntityRole[](0), adminWallet);
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
     * @notice Converts array of Permisions to compact wallet roles.
     *
     * Calculates the compact wallet roles as the sum of individual wallet roles.
     * Use "or" to get the correct value even if the same role is specified more than once.
     *
     * @param _walletRole - the array of wallet roles
     * @return compactWalletRole - the compact representation of wallet roles
     */
    function walletRoleToCompactWalletRoles(
        FermionTypes.WalletRole[] calldata _walletRole
    ) internal pure returns (uint8 compactWalletRole) {
        if (_walletRole.length == 0) {
            return ROLE_PERMISSION_MASK;
        }

        for (uint256 i = 0; i < _walletRole.length; i++) {
            uint8 walletRole = uint8(1) << uint8(_walletRole[i]);
            compactWalletRole |= walletRole;
        }
    }
}
