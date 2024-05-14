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

        storeEntity(entityId, msgSender, newEntity, _roles, _metadata);
        storeCompactWalletRole(entityId, msgSender, 0xff << (31 * BYTE_SIZE), true, pl, pe); // compact role for all current and potential future roles
        emitAdminWalletAddedOrRemoved(entityId, msgSender, true);
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
        addOrRemoveEntityWallets(_entityId, _wallets, _entityRoles, _walletRoles, true);
    }

    /**
     * @notice Remove entity wallets.
     *
     * Emits an EntityWalletRemoved event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     * - Caller is not the admin for the entity role
     * - Length of _wallets, _entityRoles and _walletRoles do not match
     * - Entity does not have the role
     *
     * @param _entityId - the entity ID
     * @param _wallets - list of wallets that acts on the seller's behalf
     * @param _entityRoles - list of corresponding roles, for which the address is given a certain wallet role. If entityRoles[i] is empty, the address is given the wallet role to all entity roles.
     * @param _walletRoles - list of wallet roles for each wallet and entity role
     */
    function removeEntityWallets(
        uint256 _entityId,
        address[] calldata _wallets,
        FermionTypes.EntityRole[][] calldata _entityRoles,
        FermionTypes.WalletRole[][][] calldata _walletRoles
    ) external {
        addOrRemoveEntityWallets(_entityId, _wallets, _entityRoles, _walletRoles, false);
    }

    /**
     * @notice Remove entity wallets.
     *
     * Emits an EntityWalletRemoved event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     * - Caller is not the admin for the entity role
     * - Length of _wallets, _entityRoles and _walletRoles do not match
     * - Entity does not have the role
     *
     * @param _entityId - the entity ID
     * @param _wallets - list of wallets that acts on the seller's behalf
     * @param _entityRoles - list of corresponding roles, for which the address is given a certain wallet role. If entityRoles[i] is empty, the address is given the wallet role to all entity roles.
     * @param _walletRoles - list of wallet roles for each wallet and entity role
     * @param _add - if true, the wallet is added, if false, it is removed
     */
    function addOrRemoveEntityWallets(
        uint256 _entityId,
        address[] calldata _wallets,
        FermionTypes.EntityRole[][] calldata _entityRoles,
        FermionTypes.WalletRole[][][] calldata _walletRoles,
        bool _add
    ) internal {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = _entityId; // for some reason this solves the stack too deep error
        validateEntityId(entityId, pl);
        if (_wallets.length != _entityRoles.length) revert ArrayLengthMismatch(_wallets.length, _entityRoles.length);
        if (_wallets.length != _walletRoles.length) revert ArrayLengthMismatch(_wallets.length, _walletRoles.length);

        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();

        uint256 compactEntityRoles = pe.entityData[entityId].roles;
        for (uint256 i = 0; i < _wallets.length; i++) {
            address wallet = _wallets[i];

            uint256 compactWalletRole = getCompactWalletRole(
                entityId,
                compactEntityRoles,
                _entityRoles[i],
                _walletRoles[i]
            );

            storeCompactWalletRole(entityId, wallet, compactWalletRole, _add, pl, pe);
            if (_add) {
                emit EntityWalletAdded(entityId, wallet, _entityRoles[i], _walletRoles[i]);
            } else {
                emit EntityWalletRemoved(entityId, wallet, _entityRoles[i], _walletRoles[i]);
            }
        }
    }

    /** Add entity wide admin wallet.
     *
     * This is different from adding a wallet with admin role for each entity role.
     * The wallet is given the admin role for all entity roles, even for roles that do not exist yet.
     * A wallet can be an entity-wide admin for only one entity. This is not checked here, but
     * only when the new admin makes its first entity admin action.
     *
     * Emits an EntityWalletAdded event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     * - Caller is not an entity admin
     *
     * @param _entityId - the entity ID
     * @param _wallet - the admin wallet address
     */
    function setEntityAdmin(uint256 _entityId, address _wallet, bool _status) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        validateEntityId(_entityId, pl);
        validateEntityAdmin(_entityId, pl);

        // set the pending admin
        pl.pendingEntityAdmin[_entityId][_wallet] = _status;

        storeCompactWalletRole(
            _entityId,
            _wallet,
            0xff << (31 * BYTE_SIZE),
            _status,
            pl,
            FermionStorage.protocolEntities()
        ); // compact role for all current and potential future roles
        emitAdminWalletAddedOrRemoved(_entityId, _wallet, _status);
    }

    /**
     * @notice Change the wallet address, i.e. transfers all wallet roles to the new address.
     *
     * If the wallet is an entity admin, it cannot change using this function.
     * It should use setEntityAdmin to set a new wallet and then revoke the old admin.
     *
     * If the wallet is used for multiple entities, the change will affect all entities.
     * If you want to change the wallet only for one entity, you need to remove the wallet from the entity
     * and add it again with the new address.
     *
     * Emits an WalletChanged event if successful.
     *
     * Reverts if:
     * - Caller is an entity admin
     * - Caller is not a wallet for any enitity
     *
     * @param _newWallet - the new wallet address
     */
    function changeWallet(address _newWallet) external {
        address msgSender = msgSender();
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = pl.entityId[msgSender];

        if (entityId != 0) revert ChangeNotAllowed(); // to change the entity admin, use setEntityAdmin and then revoke the old admin

        uint256 walletId = pl.walletId[msgSender];
        if (walletId == 0) revert NoSuchEntity();

        pl.walletId[_newWallet] = walletId;
        delete pl.walletId[msgSender];

        emit WalletChanged(msgSender, _newWallet);
    }

    /**
     * @notice Updates an entity.
     *
     * Emits an EntityStored event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     * - No role is specified
     * - Caller is not an admin for the entity role
     *
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function updateEntity(
        uint256 _entityId,
        FermionTypes.EntityRole[] calldata _roles,
        string calldata _metadata
    ) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        validateEntityId(_entityId, pl);
        validateEntityAdmin(_entityId, FermionStorage.protocolLookups());
        FermionTypes.EntityData storage entityData = fetchEntityData(_entityId);

        storeEntity(_entityId, address(0), entityData, _roles, _metadata);
    }

    /**
     * @notice Deletes an entity.
     *
     * Emits an EntityDeleted event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     * - Caller is not an admin for the entity role
     *
     * @param _entityId - the entity ID
     */
    function deleteEntity(uint256 _entityId) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        validateEntityId(_entityId, pl);
        address entityAddress = validateEntityAdmin(_entityId, pl);

        delete FermionStorage.protocolEntities().entityData[_entityId];
        delete pl.entityId[entityAddress];

        emit EntityDeleted(_entityId, entityAddress);
    }

    /**
     * @notice Gets the details about the entity.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _entityAddress - the address of the entity
     * @return entityId - the entity ID
     * @return roles - the roles the entity has
     * @return metadataURI - the metadata URI for the entity
     */
    function getEntity(
        address _entityAddress
    ) external view returns (uint256 entityId, FermionTypes.EntityRole[] memory roles, string memory metadataURI) {
        FermionTypes.EntityData storage entityData;
        (entityId, entityData) = fetchEntityData(_entityAddress);

        roles = compactRoleToRoles(entityData.roles);
        metadataURI = entityData.metadataURI;
    }

    /**
     * @notice Gets the details about the entity.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _entityId - the entity ID
     * @return entityAddress - the address of the entity
     * @return roles - the roles the entity has
     * @return metadataURI - the metadata URI for the entity
     */
    function getEntity(
        uint256 _entityId
    ) external view returns (address entityAddress, FermionTypes.EntityRole[] memory roles, string memory metadataURI) {
        validateEntityId(_entityId, FermionStorage.protocolLookups());
        FermionTypes.EntityData storage entityData = fetchEntityData(_entityId);
        entityAddress = entityData.admin;
        roles = compactRoleToRoles(entityData.roles);
        metadataURI = entityData.metadataURI;
    }

    /**
     * @notice Tells if a wallet has a specific wallet role for entity id and its role.
     *
     * @param _entityId - the entity ID
     * @param _walletAddress - the address of the wallet
     * @param _entityRole - the role of the entity
     * @param _walletRole - the wallet role
     */
    function hasRole(
        uint256 _entityId,
        address _walletAddress,
        FermionTypes.EntityRole _entityRole,
        FermionTypes.WalletRole _walletRole
    ) public view returns (bool) {
        return hasRole(_entityId, _walletAddress, _entityRole, _walletRole, false);
    }

    /**
     * @notice Tells if a wallet has a specific wallet role for whole entity.
     *
     * @param _entityId - the entity ID
     * @param _walletAddress - the address of the wallet
     * @param _walletRole - the wallet role
     */
    function hasEntityRole(
        uint256 _entityId,
        address _walletAddress,
        FermionTypes.WalletRole _walletRole
    ) internal view returns (bool) {
        return hasRole(_entityId, _walletAddress, FermionTypes.EntityRole(0), _walletRole, true);
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
    function hasRole(
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
            (!_requireEntityWide && hasRoleSpecificPermission(_entityRole, walletRole, compactWalletRole));
    }

    function hasRoleSpecificPermission(
        FermionTypes.EntityRole _entityRole,
        uint256 _walletRole,
        uint256 _compactWalletRole
    ) internal pure returns (bool) {
        uint256 roleSpecificPermission = _compactWalletRole >> (uint256(_entityRole) * BYTE_SIZE);
        return roleSpecificPermission & _walletRole != 0;
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
        FermionTypes.EntityRole[] calldata _roles,
        string calldata _metadata
    ) internal {
        if (_admin != address(0)) {
            _entityData.admin = _admin;
        }
        _entityData.roles = rolesToCompactRole(_roles);
        _entityData.metadataURI = _metadata;

        // Notify watchers of state change
        emit EntityStored(_entityId, msgSender(), _roles, _metadata);
    }

    /**
     * @notice Gets the entity data from the storage.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _entityAddress - the address of the entity
     * @return entityId - the entity ID
     * @return entityData -  storage pointer to data location
     */
    function fetchEntityData(
        address _entityAddress
    ) internal view returns (uint256 entityId, FermionTypes.EntityData storage entityData) {
        entityId = FermionStorage.protocolLookups().entityId[_entityAddress];
        if (entityId == 0) revert NoSuchEntity();

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
    ) internal pure returns (uint256 compactWalletRole) {
        if (_walletRole.length == 0) {
            return WALLET_ROLE_MASK;
        }

        for (uint256 i = 0; i < _walletRole.length; i++) {
            uint256 walletRole = 1 << uint256(_walletRole[i]);
            compactWalletRole |= walletRole;
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
     */
    function getCompactWalletRole(
        uint256 _entityId,
        uint256 _compactEntityRoles,
        FermionTypes.EntityRole[] calldata _entityRoles,
        FermionTypes.WalletRole[][] calldata _walletRoles
    ) internal view returns (uint256 compactWalletRole) {
        address msgSender = msgSender();

        if (_entityRoles.length == 0) {
            if (_walletRoles.length != 1) revert ArrayLengthMismatch(1, _walletRoles.length);

            // To set entity-wide wallet roles, the callem must have entity-wide admin role
            if (!hasEntityRole(_entityId, msgSender, FermionTypes.WalletRole.Admin))
                revert NotEntityAdmin(_entityId, msgSender);

            uint256 compactWalletRolePerEntityRole = walletRoleToCompactWalletRoles(_walletRoles[0]);
            compactWalletRole = compactWalletRolePerEntityRole << (31 * BYTE_SIZE); // put in the first byte.
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

                uint256 compactWalletRolePerEntityRole = walletRoleToCompactWalletRoles(_walletRoles[i]);

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
            emit EntityWalletAdded(_entityId, _wallet, new FermionTypes.EntityRole[](0), adminWallet);
        } else {
            emit EntityWalletRemoved(_entityId, _wallet, new FermionTypes.EntityRole[](0), adminWallet);
        }
    }

    /** Reverts if the entity ID is invalid
     */
    function validateEntityId(uint256 _entityId, FermionStorage.ProtocolLookups storage pl) internal view {
        if (_entityId == 0 || _entityId > pl.entityCounter) revert NoSuchEntity();
    }

    /**
     * @notice Check if the caller is the admin or accept the admin role if it's pending admin.
     *
     * Reverts if:
     * - Caller is neither the admin and nor the pending admin for the entity
     * - Caller is already an admin for another entity
     *
     * @param _entityId - the entity ID
     */
    function validateEntityAdmin(
        uint256 _entityId,
        FermionStorage.ProtocolLookups storage pl
    ) internal returns (address) {
        address msgSender = msgSender();
        uint256 callerEntityId = pl.entityId[msgSender];
        if (callerEntityId == 0) {
            // Try to accept the admin role
            acceptAdminRole(_entityId, msgSender, pl);
        } else {
            if (callerEntityId != _entityId) revert NotEntityAdmin(_entityId, msgSender);
        }
        return msgSender;
    }

    /**
     * @notice Accept the admin role for an entity.
     *
     * Reverts if:
     * - Caller is not pending admin for the entity
     * - Caller is already an admin for another entity
     *
     * @param _entityId - the entity ID
     */
    function acceptAdminRole(uint256 _entityId, address _wallet, FermionStorage.ProtocolLookups storage pl) internal {
        if (!pl.pendingEntityAdmin[_entityId][_wallet]) revert NotEntityAdmin(_entityId, _wallet);

        delete pl.pendingEntityAdmin[_entityId][_wallet];
        pl.entityId[_wallet] = _entityId;

        FermionTypes.EntityData storage entityData = fetchEntityData(_entityId);
        delete pl.entityId[entityData.admin];

        entityData.admin = _wallet;
    }
}
