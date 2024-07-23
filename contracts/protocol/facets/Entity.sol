// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { BYTE_SIZE } from "../domain/Constants.sol";
import { EntityErrors, FermionGeneralErrors, OfferErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Context } from "../libs/Context.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { IEntityEvents } from "../interfaces/events/IEntityEvents.sol";

import { FermionWrapper } from "../clients/FermionWrapper.sol";

/**
 * @title EntityFacet
 *
 * @notice Handles entity management.
 */
contract EntityFacet is Context, EntityErrors, Access, IEntityEvents {
    uint256 private constant TOTAL_ROLE_COUNT = uint256(type(FermionTypes.EntityRole).max) + 1;
    uint256 private constant ENTITY_ROLE_MASK = (1 << TOTAL_ROLE_COUNT) - 1;
    uint256 private constant WALLET_ROLE_MASK = (1 << (uint256(type(FermionTypes.WalletRole).max) + 1)) - 1;

    /**
     * @notice Creates an entity.
     *
     * Emits an EntityStored event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity exists already
     *
     * @param _roles - the roles the entity will have
     * @param _metadata - the metadata URI for the entity
     */
    function createEntity(
        FermionTypes.EntityRole[] calldata _roles,
        string calldata _metadata
    ) external notPaused(FermionTypes.PausableRegion.Entity) nonReentrant {
        address msgSender = _msgSender();
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = pl.entityId[msgSender];
        if (entityId != 0) revert EntityAlreadyExists();

        EntityLib.createEntity(msgSender, _roles, _metadata, pl);
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
     * - Entity region is paused
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
    ) external notPaused(FermionTypes.PausableRegion.Entity) nonReentrant {
        addOrRemoveEntityWallets(_entityId, _wallets, _entityRoles, _walletRoles, true);
    }

    /**
     * @notice Remove entity wallets.
     *
     * Emits an EntityWalletRemoved event if successful.
     *
     * Reverts if:
     * - Entity region is paused
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
    ) external notPaused(FermionTypes.PausableRegion.Entity) nonReentrant {
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
        EntityLib.validateEntityId(entityId, pl);
        if (_wallets.length != _entityRoles.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_wallets.length, _entityRoles.length);
        if (_wallets.length != _walletRoles.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_wallets.length, _walletRoles.length);

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

            EntityLib.storeCompactWalletRole(entityId, wallet, compactWalletRole, _add, pl, pe);
            if (_add) {
                emit EntityWalletAdded(entityId, wallet, _entityRoles[i], _walletRoles[i]);
            } else {
                emit EntityWalletRemoved(entityId, wallet, _entityRoles[i], _walletRoles[i]);
            }
        }
    }

    /** Add seller's facilitator.
     *
     * Another entity with seller role can act as a facilitator for the seller.
     * This function enables the facilitator to act on behalf of the seller.
     *
     * Emits an FacilitatorAdded for each facilitator event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not an entity admin
     * - Facilitator does not have a seller role
     * - Facilitator is already a facilitator for the seller
     *
     * @dev Pausing modifier is enforced via `addOrRemoveFacilitators`
     *
     * @param _sellerId - the seller's entity ID
     * @param _facilitatorIds - the facilitator's entity IDs
     */
    function addFacilitators(uint256 _sellerId, uint256[] calldata _facilitatorIds) external {
        addOrRemoveFacilitators(_sellerId, _facilitatorIds, true);
    }

    /** Remove seller's facilitator.
     *
     * Removes the facilitator's ability to act on behalf of the seller.
     *
     * Emits an FacilitatorRemoved event for each facilitator if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not an entity admin
     *
     * @dev Pausing modifier is enforced via `addOrRemoveFacilitators`
     *
     * @param _sellerId - the seller's entity ID
     * @param _facilitatorIds - the facilitator's entity IDs
     */
    function removeFacilitators(uint256 _sellerId, uint256[] calldata _facilitatorIds) external {
        addOrRemoveFacilitators(_sellerId, _facilitatorIds, false);
    }

    /** Add entity wide admin wallet.
     *
     * This is different from adding a wallet with admin role for each entity role.
     * The wallet is given the admin role for all entity roles, even for roles that do not exist yet.
     * A wallet can be an entity-wide admin for only one entity. This is not checked here, but
     * only when the new admin makes its first entity admin action.
     *
     * Emits an EntityAdminPending event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not an entity admin
     *
     * @dev Pausing modifier is enforced via `validateEntityAdmin`
     *
     * @param _entityId - the entity ID
     * @param _wallet - the admin wallet address
     */
    function setEntityAdmin(uint256 _entityId, address _wallet) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        EntityLib.validateEntityId(_entityId, pl);
        validateEntityAdmin(_entityId, pl);

        // set the pending admin
        pl.entityLookups[_entityId].pendingEntityAdmin = _wallet;

        emit EntityAdminPending(_entityId, _wallet);
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
     * - Entity region is paused
     * - New and old wallet are the same
     * - Caller is an entity admin
     * - Caller is not a wallet for any enitity
     * - New wallet is already a wallet for an entity
     *
     * @param _newWallet - the new wallet address
     */
    function changeWallet(address _newWallet) external notPaused(FermionTypes.PausableRegion.Entity) nonReentrant {
        address msgSender = _msgSender();
        if (msgSender == _newWallet) revert NewWalletSameAsOld();

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = pl.entityId[msgSender];

        if (entityId != 0) revert ChangeNotAllowed(); // to change the entity admin, use setEntityAdmin and then revoke the old admin

        uint256 walletId = pl.walletId[msgSender];
        if (walletId == 0) revert NoSuchEntity(0);
        delete pl.walletId[msgSender];

        if (pl.walletId[_newWallet] != 0) revert WalletAlreadyExists(_newWallet);
        pl.walletId[_newWallet] = walletId;

        emit WalletChanged(msgSender, _newWallet);
    }

    /**
     * @notice Updates an entity.
     *
     * Emits an EntityStored event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not an admin for the entity role
     *
     * @dev Pausing modifier is enforced via `validateEntityAdmin`
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
        EntityLib.validateEntityId(_entityId, pl);
        validateEntityAdmin(_entityId, pl);
        FermionTypes.EntityData storage entityData = EntityLib.fetchEntityData(_entityId);

        EntityLib.storeEntity(_entityId, address(0), entityData, _roles, _metadata);
    }

    /**
     * @notice Updates the owner of the wrapper contract, associated with the offer id
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not an admin for the entity role
     * - New owner is not the seller's assistant or facilitator
     *
     * @dev Pausing modifier is enforced via `validateEntityAdmin`
     *
     * @param _offerId - the offer ID
     * @param _newOwner - the new owner address
     */
    function transferWrapperContractOwnership(uint256 _offerId, address _newOwner) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        address wrapperAddress = pl.offerLookups[_offerId].fermionFNFTAddress;
        if (wrapperAddress == address(0)) revert OfferErrors.NoSuchOffer(_offerId);

        FermionTypes.Offer storage offer = FermionStorage.protocolEntities().offer[_offerId];
        uint256 entityId = offer.sellerId;
        validateEntityAdmin(entityId, pl);

        EntityLib.validateSellerAssistantOrFacilitator(entityId, offer.facilitatorId, _newOwner);

        FermionWrapper(payable(wrapperAddress)).transferOwnership(_newOwner);
    }

    /**
     * @notice Gets the details about the entity.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _adminWallet - the address of the entity's admin
     * @return entityId - the entity ID
     * @return roles - the roles the entity has
     * @return metadataURI - the metadata URI for the entity
     */
    function getEntity(
        address _adminWallet
    ) external view returns (uint256 entityId, FermionTypes.EntityRole[] memory roles, string memory metadataURI) {
        FermionTypes.EntityData storage entityData;
        (entityId, entityData) = EntityLib.fetchEntityData(_adminWallet);

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
     * @return adminWallet - the address of the entity's admin
     * @return roles - the roles the entity has
     * @return metadataURI - the metadata URI for the entity
     */
    function getEntity(
        uint256 _entityId
    ) external view returns (address adminWallet, FermionTypes.EntityRole[] memory roles, string memory metadataURI) {
        FermionTypes.EntityData storage entityData = EntityLib.fetchEntityData(_entityId);
        adminWallet = entityData.admin;
        roles = compactRoleToRoles(entityData.roles);
        metadataURI = entityData.metadataURI;
    }

    /** Returns the list of seller's facilitator.
     *
     * @param _sellerId - the seller's entity ID
     * @return facilitatorIds - the facilitator's entity IDs
     */
    function getSellersFacilitators(uint256 _sellerId) external view returns (uint256[] memory facilitatorIds) {
        return FermionStorage.protocolLookups().sellerLookups[_sellerId].sellerFacilitators;
    }

    /** Tells if the entity is seller's factiliator.
     *
     * @param _sellerId - the seller's entity ID
     * @param _facilitatorId - the facilitator's entity ID
     * @return isSellersFcilitator - the facilitator's status
     */
    function isSellersFacilitator(
        uint256 _sellerId,
        uint256 _facilitatorId
    ) external view returns (bool isSellersFcilitator) {
        return FermionStorage.protocolLookups().sellerLookups[_sellerId].isSellersFacilitator[_facilitatorId];
    }

    /**
     * @notice Tells if a wallet has a specific wallet role for entity id and its role.
     *
     * @param _entityId - the entity ID
     * @param _walletAddress - the address of the wallet
     * @param _entityRole - the role of the entity
     * @param _walletRole - the wallet role
     */
    function hasWalletRole(
        uint256 _entityId,
        address _walletAddress,
        FermionTypes.EntityRole _entityRole,
        FermionTypes.WalletRole _walletRole
    ) external view returns (bool) {
        return EntityLib.hasWalletRole(_entityId, _walletAddress, _entityRole, _walletRole, false);
    }

    /**
     * @notice Tells if a entity has a specific role.
     *
     * @param _entityId - the entity ID
     * @param _entityRole - the role of the entity
     */
    function hasEntityRole(uint256 _entityId, FermionTypes.EntityRole _entityRole) external view returns (bool) {
        EntityLib.validateEntityId(_entityId, FermionStorage.protocolLookups());

        uint256 compactEntityRoles = FermionStorage.protocolEntities().entityData[_entityId].roles;

        return EntityLib.checkEntityRole(compactEntityRoles, _entityRole);
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
        address msgSender = _msgSender();

        if (_entityRoles.length == 0) {
            if (_walletRoles.length != 1) revert FermionGeneralErrors.ArrayLengthMismatch(1, _walletRoles.length);

            // To set entity-wide wallet roles, the caller must have entity-wide admin role
            if (
                !EntityLib.hasWalletRole(
                    _entityId,
                    msgSender,
                    FermionTypes.EntityRole(0),
                    FermionTypes.WalletRole.Admin,
                    true
                )
            ) revert NotEntityAdmin(_entityId, msgSender);

            uint256 compactWalletRolePerEntityRole = walletRoleToCompactWalletRoles(_walletRoles[0]);
            compactWalletRole = compactWalletRolePerEntityRole << (31 * BYTE_SIZE); // put in the first byte.
        } else {
            if (_entityRoles.length != _walletRoles.length)
                revert FermionGeneralErrors.ArrayLengthMismatch(_entityRoles.length, _walletRoles.length);
            for (uint256 i = 0; i < _entityRoles.length; i++) {
                FermionTypes.EntityRole entityRole = _entityRoles[i];
                // Check that the entity has the role
                EntityLib.validateEntityRole(_entityId, _compactEntityRoles, entityRole);

                if (!EntityLib.hasWalletRole(_entityId, msgSender, entityRole, FermionTypes.WalletRole.Admin, false))
                    revert NotAdmin(msgSender, _entityId, entityRole);

                uint256 compactWalletRolePerEntityRole = walletRoleToCompactWalletRoles(_walletRoles[i]);

                uint256 role = compactWalletRolePerEntityRole << (uint256(entityRole) * BYTE_SIZE); // put in the right byte.
                compactWalletRole |= role;
            }
        }
    }

    /**
     * @notice Check if the caller is the admin or accept the admin role if it's pending admin.
     *
     * Reverts if:
     * - Entity region is paused
     * - Caller is neither the admin and nor the pending admin for the entity
     * - Caller is already an admin for another entity
     *
     * @param _entityId - the entity ID
     */
    function validateEntityAdmin(
        uint256 _entityId,
        FermionStorage.ProtocolLookups storage pl
    ) internal notPaused(FermionTypes.PausableRegion.Entity) nonReentrant returns (address) {
        address msgSender = _msgSender();
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
        FermionStorage.EntityLookups storage entityLookups = pl.entityLookups[_entityId];
        if (entityLookups.pendingEntityAdmin != _wallet) revert NotEntityAdmin(_entityId, _wallet);

        delete entityLookups.pendingEntityAdmin;

        FermionTypes.EntityData storage entityData = EntityLib.fetchEntityData(_entityId);
        address previousAdmin = entityData.admin;
        delete pl.entityId[previousAdmin];

        entityData.admin = _wallet;
        pl.entityId[_wallet] = _entityId;

        // add new admin wallet
        EntityLib.storeCompactWalletRole(
            _entityId,
            _wallet,
            0xff << (31 * BYTE_SIZE),
            true,
            pl,
            FermionStorage.protocolEntities()
        ); // compact role for all current and potential future roles

        // strip old wallet of all privileges
        EntityLib.storeCompactWalletRole(
            _entityId,
            previousAdmin,
            0xff << (31 * BYTE_SIZE),
            true,
            pl,
            FermionStorage.protocolEntities()
        );

        EntityLib.emitAdminWalletAddedOrRemoved(_entityId, _wallet, true);
        EntityLib.emitAdminWalletAddedOrRemoved(_entityId, previousAdmin, false);
    }

    /** Remove seller's facilitator.
     *
     * Removes the facilitator's ability to act on behalf of the seller.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not an entity admin
     * - When adding, if the facilitator does not have a seller role
     *
     * @dev Pausing modifier is enforced via `validateEntityAdmin`
     *
     * @param _sellerId - the seller's entity ID
     * @param _facilitatorIds - the facilitator's entity IDs
     * @param _add - if true, the facilitator is added, if false, it is removed
     */
    function addOrRemoveFacilitators(uint256 _sellerId, uint256[] calldata _facilitatorIds, bool _add) internal {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        EntityLib.validateEntityId(_sellerId, pl);
        validateEntityAdmin(_sellerId, pl);

        FermionStorage.SellerLookups storage sellerLookups = pl.sellerLookups[_sellerId];
        uint256[] storage facilitators = sellerLookups.sellerFacilitators;
        mapping(uint256 => bool) storage isFacilitator = sellerLookups.isSellersFacilitator;

        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();
        for (uint256 i = 0; i < _facilitatorIds.length; i++) {
            uint256 facilitatorId = _facilitatorIds[i];
            if (_add) {
                if (isFacilitator[facilitatorId]) revert FacilitatorAlreadyExists(_sellerId, facilitatorId);

                EntityLib.validateEntityRole(
                    facilitatorId,
                    pe.entityData[facilitatorId].roles,
                    FermionTypes.EntityRole.Seller
                );

                facilitators.push(facilitatorId);

                emit FacilitatorAdded(_sellerId, facilitatorId);
            } else {
                uint256 facilitatorsLength = facilitators.length;
                for (uint256 j = 0; j < facilitatorsLength; j++) {
                    if (facilitators[j] == facilitatorId) {
                        if (j != facilitatorsLength - 1) facilitators[j] = facilitators[facilitatorsLength - 1];
                        facilitators.pop();

                        emit FacilitatorRemoved(_sellerId, facilitatorId);
                        break;
                    }
                }
            }

            isFacilitator[facilitatorId] = _add;
        }
    }
}
