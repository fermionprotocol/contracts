// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Context } from "../libs/Context.sol";
import { IEntityEvents } from "../interfaces/events/IEntityEvents.sol";
import "hardhat/console.sol";

/**
 * @title EntityFacet
 *
 * @notice Handles entity management.
 */
contract EntityFacet is Context, FermionErrors, IEntityEvents {
    uint256 private constant TOTAL_ROLE_COUNT = uint256(type(FermionTypes.EntityRole).max) + 1;
    uint256 private constant ENTITY_ROLE_MASK = (1 << TOTAL_ROLE_COUNT) - 1;
    uint256 private constant WALLET_ROLE_MASK = (1 << (uint256(type(FermionTypes.WalletRole).max) + 1)) - 1;
    uint256 private constant BYTE_SIZE = 8;

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
        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();
        FermionTypes.EntityData storage newEntity = pe.entityData[entityId];

        storeEntity(newEntity, _roles, _metadata);
        storeCompactWalletRole(entityId, msgSender, 0xff << (31 * BYTE_SIZE), pl, pe); // compact role for all current and potential future roles
        emitAdminWalletAdded(entityId, msgSender);
    }

    /**
     * @notice Add entity wallets.
     *
     * Each address can have multiple wallet roles from FermionTypes.WalletRole
     * For each role that the entity has, the wallet roles are set independently.
     *
     * Emits an EntityWalletAdded event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     * - Caller is not an admin for the entity role
     * - Length of _wallets, _entityRoles and _walletRoles do not match
     * - Entity does not have the role
     *
     * @param _wallets - list of wallets that acts on the seller's behalf
     * @param _entityRoles - list of corresponding roles, for which the address is given a certain wallet role. If entityRoles[i] is empty, the address is given the wallet role to all entity roles.
     * @param _walletRoles - list of wallet roles for each wallet and entity role
     */
    function addEntityWallets(
        uint256 _entityId,
        address[] calldata _wallets,
        FermionTypes.EntityRole[][] calldata _entityRoles,
        FermionTypes.WalletRole[][][] calldata _walletRoles
    ) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = _entityId; // for some reason this solves the stack too deep error
        validateEntityId(entityId, pl);
        if (_wallets.length != _entityRoles.length) revert ArrayLengthMismatch(_wallets.length, _entityRoles.length);
        if (_wallets.length != _walletRoles.length) revert ArrayLengthMismatch(_wallets.length, _walletRoles.length);

        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();

        uint256 compactEntityRoles = pe.entityData[entityId].roles;
        for (uint256 i = 0; i < _wallets.length; i++) {
            address wallet = _wallets[i];

            (uint256 compactWalletRole, bool isAdmin) = getCompactWalletRole(
                entityId,
                compactEntityRoles,
                _entityRoles[i],
                _walletRoles[i]
            );

            if (isAdmin) {
                pl.pendingAdminEntity[entityId][wallet] = true;
            }

            storeCompactWalletRole(entityId, wallet, compactWalletRole, pl, pe);

            emit EntityWalletAdded(_entityId, wallet, _entityRoles[i], _walletRoles[i]);
        }
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

        emitAdminWalletAdded(_entityId, msgSender);
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
     * @notice Tells if a wallet has a specific wallet role for entity id and its role.
     *
     * @param _entityId - the entity ID
     * @param _walletAddress - the address of the wallet
     * @param _role - the role of the entity
     * @param _walletRole - the wallet role
     */
    function hasRole(
        uint256 _entityId,
        address _walletAddress,
        FermionTypes.EntityRole _role,
        FermionTypes.WalletRole _walletRole
    ) public view returns (bool) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        validateEntityId(_entityId, pl);

        uint256 walletId = pl.walletId[_walletAddress];

        if (walletId == 0) return false;

        uint256 compactWalletRole = FermionStorage.protocolEntities().walletRole[walletId][_entityId];
        uint256 walletRole = 1 << uint256(_walletRole);
        uint256 entityWidePermission = compactWalletRole >> (31 * BYTE_SIZE);
        uint256 roleSpecificPermission = compactWalletRole >> (uint256(_role) * BYTE_SIZE);

        return (entityWidePermission & walletRole != 0) || (roleSpecificPermission & walletRole != 0);
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
     * @return isAdmin - the flag if the wallet was assinged admin role
     */
    function walletRoleToCompactWalletRoles(
        FermionTypes.WalletRole[] calldata _walletRole
    ) internal pure returns (uint256 compactWalletRole, bool isAdmin) {
        if (_walletRole.length == 0) {
            return (WALLET_ROLE_MASK, true);
        }

        for (uint256 i = 0; i < _walletRole.length; i++) {
            uint256 walletRole = 1 << uint256(_walletRole[i]);
            compactWalletRole |= walletRole;
            if (_walletRole[i] == FermionTypes.WalletRole.Admin) {
                isAdmin = true;
            }
        }
    }

    /**
     * @notice Calculates the compact wallet role for the entity and wallet.
     *
     * Calculates the complete compact wallet role (for all entity roles)
     * as the sum of individual comapct wallet roles (fot each entity role)
     * Each individual compact wallet role is stored in a separate byte (one byte per entity role)
     *
     * @param _entityId - the entity ID
     * @param _compactEntityRoles - the compact representation of entity roles
     * @param _entityRoles - the array of entity roles
     * @param _walletRoles - the array of wallet roles
     * @return compactWalletRole - the compact representation of wallet roles
     * @return isAdmin - the flag if the wallet was assinged admin role
     */
    function getCompactWalletRole(
        uint256 _entityId,
        uint256 _compactEntityRoles,
        FermionTypes.EntityRole[] calldata _entityRoles,
        FermionTypes.WalletRole[][] calldata _walletRoles
    ) internal view returns (uint256 compactWalletRole, bool isAdmin) {
        uint256 compactWalletRolePerEntityRole;
        address msgSender = msgSender();

        if (_entityRoles.length == 0) {
            if (_walletRoles.length > 1) revert ArrayLengthMismatch(1, _walletRoles.length);

            // ToDo: refactor
            if (!hasRole(_entityId, msgSender, FermionTypes.EntityRole.Reseller, FermionTypes.WalletRole.Admin))
                revert NotAdmin(msgSender, _entityId, FermionTypes.EntityRole.Reseller);
            if (!hasRole(_entityId, msgSender, FermionTypes.EntityRole.Buyer, FermionTypes.WalletRole.Admin))
                revert NotAdmin(msgSender, _entityId, FermionTypes.EntityRole.Buyer);
            if (!hasRole(_entityId, msgSender, FermionTypes.EntityRole.Verifier, FermionTypes.WalletRole.Admin))
                revert NotAdmin(msgSender, _entityId, FermionTypes.EntityRole.Verifier);
            if (!hasRole(_entityId, msgSender, FermionTypes.EntityRole.Custodian, FermionTypes.WalletRole.Admin))
                revert NotAdmin(msgSender, _entityId, FermionTypes.EntityRole.Custodian);

            (compactWalletRolePerEntityRole, isAdmin) = walletRoleToCompactWalletRoles(_walletRoles[0]);
            uint256 role = compactWalletRolePerEntityRole << (31 * BYTE_SIZE); // put in the first byte.
            compactWalletRole |= role;
        } else {
            if (_entityRoles.length != _walletRoles.length)
                revert ArrayLengthMismatch(_entityRoles.length, _walletRoles.length);
            for (uint256 i = 0; i < _entityRoles.length; i++) {
                FermionTypes.EntityRole entityRole = _entityRoles[i];
                // Check that the entity has the role
                if (_compactEntityRoles & (1 << uint256(entityRole)) == 0) {
                    revert EntityHasNoRole(_entityId, entityRole);
                }

                if (!hasRole(_entityId, msgSender, entityRole, FermionTypes.WalletRole.Admin))
                    revert NotAdmin(msgSender, _entityId, entityRole);

                (compactWalletRolePerEntityRole, isAdmin) = walletRoleToCompactWalletRoles(_walletRoles[i]);

                uint256 role = compactWalletRolePerEntityRole << (uint256(entityRole) * BYTE_SIZE); // put in the right byte.
                compactWalletRole |= role;
            }
        }
    }

    /**
     * @notice Stores compact wallet role for the entity and wallet.
     *
     * @param _entityId - the entity ID
     * @param _wallet - the wallet address
     * @param _compactWalletRole - the compact wallet role
     * @param pl - the protocol lookups storage
     * @param pe - the protocol entities storage
     */
    function storeCompactWalletRole(
        uint256 _entityId,
        address _wallet,
        uint256 _compactWalletRole,
        FermionStorage.ProtocolLookups storage pl,
        FermionStorage.ProtocolEntities storage pe
    ) internal {
        uint256 walletId = pl.walletId[_wallet];

        if (walletId == 0) {
            walletId = ++pl.walletsCounter;
            pl.walletId[_wallet] = walletId;
        }

        pe.walletRole[walletId][_entityId] |= _compactWalletRole;
    }

    /**
     * @notice Creates event arguments and emits EntityWalletAdded, when entity-wide admin is added.
     *
     * @param _entityId - the entity ID
     * @param _wallet - the admin wallet address
     */
    function emitAdminWalletAdded(uint256 _entityId, address _wallet) internal {
        FermionTypes.WalletRole[][] memory adminWallet = new FermionTypes.WalletRole[][](1);
        adminWallet[0] = new FermionTypes.WalletRole[](1);
        adminWallet[0][0] = FermionTypes.WalletRole.Admin;
        emit EntityWalletAdded(_entityId, _wallet, new FermionTypes.EntityRole[](0), adminWallet);
    }

    /** Reverts if the entity ID is invalid
     */
    function validateEntityId(uint256 _entityId, FermionStorage.ProtocolLookups storage pl) internal view {
        if (_entityId == 0 || _entityId > pl.entityCounter) revert NoSuchEntity();
    }
}
