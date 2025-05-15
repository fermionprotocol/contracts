// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { BYTE_SIZE, ANY_ENTITY_ROLE } from "../domain/Constants.sol";
import { EntityErrors, FermionGeneralErrors, OfferErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Access } from "../bases/mixins/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Context } from "../bases/mixins/Context.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { IEntityEvents } from "../interfaces/events/IEntityEvents.sol";

import { FermionFNFTLib } from "../libs/FermionFNFTLib.sol";

/**
 * @title EntityFacet
 *
 * @notice Handles entity management.
 */
contract EntityFacet is Context, EntityErrors, Access, IEntityEvents {
    uint256 private constant WALLET_ROLE_MASK = (1 << (uint256(type(FermionTypes.AccountRole).max) + 1)) - 1;
    using FermionFNFTLib for address;

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
     * @return entityId - the entity ID
     */
    function createEntity(
        FermionTypes.EntityRole[] calldata _roles,
        string calldata _metadata
    ) external notPaused(FermionTypes.PausableRegion.Entity) nonReentrant returns (uint256 entityId) {
        address msgSender = _msgSender();
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        entityId = pl.entityId[msgSender];
        if (entityId != 0) revert EntityAlreadyExists();

        entityId = EntityLib.createEntity(msgSender, _roles, _metadata, pl);
    }

    /**
     * @notice Add entity accounts.
     *
     * Each address can have multiple account roles from FermionTypes.AccountRole
     * For each role that the entity has, the account roles are set independently.
     *
     * Emits an EntityAccountAdded event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not an admin for the entity role
     * - Length of _accounts, _entityRoles and _accountRoles do not match
     * - Entity does not have the role
     *
     * @param _accounts - list of accounts that acts on the seller's behalf
     * @param _entityRoles - list of corresponding roles, for which the address is given a certain account role. If entityRoles[i] is empty, the address is given the account role to all entity roles.
     * @param _accountRoles - list of account roles for each account and entity role
     */
    function addEntityAccounts(
        uint256 _entityId,
        address[] calldata _accounts,
        FermionTypes.EntityRole[][] calldata _entityRoles,
        FermionTypes.AccountRole[][][] calldata _accountRoles
    ) external {
        addOrRemoveEntityAccounts(_entityId, _accounts, _entityRoles, _accountRoles, true);
    }

    /**
     * @notice Remove entity accounts.
     *
     * Emits an EntityAccountRemoved event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not the admin for the entity role
     * - Length of _accounts, _entityRoles and _accountRoles do not match
     * - Entity does not have the role
     *
     * @param _entityId - the entity ID
     * @param _accounts - list of accounts that acts on the seller's behalf
     * @param _entityRoles - list of corresponding roles, for which the address is given a certain account role. If entityRoles[i] is empty, the address is given the account role to all entity roles.
     * @param _accountRoles - list of account roles for each account and entity role
     */
    function removeEntityAccounts(
        uint256 _entityId,
        address[] calldata _accounts,
        FermionTypes.EntityRole[][] calldata _entityRoles,
        FermionTypes.AccountRole[][][] calldata _accountRoles
    ) external {
        addOrRemoveEntityAccounts(_entityId, _accounts, _entityRoles, _accountRoles, false);
    }

    /**
     * @notice Remove entity accounts.
     *
     * Emits an EntityAccountRemoved event if successful.
     *
     * Reverts if:
     * - Entity does not exist
     * - Caller is not the admin for the entity role
     * - Length of _accounts, _entityRoles and _accountRoles do not match
     * - Entity does not have the role
     *
     * @param _entityId - the entity ID
     * @param _accounts - list of accounts that acts on the seller's behalf
     * @param _entityRoles - list of corresponding roles, for which the address is given a certain account role. If entityRoles[i] is empty, the address is given the account role to all entity roles.
     * @param _accountRoles - list of account roles for each account and entity role
     * @param _add - if true, the account is added, if false, it is removed
     */
    function addOrRemoveEntityAccounts(
        uint256 _entityId,
        address[] calldata _accounts,
        FermionTypes.EntityRole[][] calldata _entityRoles,
        FermionTypes.AccountRole[][][] calldata _accountRoles,
        bool _add
    ) internal notPaused(FermionTypes.PausableRegion.Entity) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = _entityId; // for some reason this solves the stack too deep error
        EntityLib.validateEntityId(entityId, pl);
        if (_accounts.length != _entityRoles.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_accounts.length, _entityRoles.length);
        if (_accounts.length != _accountRoles.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_accounts.length, _accountRoles.length);

        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();

        for (uint256 i; i < _accounts.length; ++i) {
            address account = _accounts[i];

            uint256 compactAccountRole = getCompactAccountRole(
                entityId,
                pe.entityData[entityId].roles,
                _entityRoles[i],
                _accountRoles[i]
            );

            EntityLib.storeCompactAccountRole(entityId, account, compactAccountRole, _add, pl, pe);
            if (_add) {
                emit EntityAccountAdded(entityId, account, _entityRoles[i], _accountRoles[i]);
            } else {
                emit EntityAccountRemoved(entityId, account, _entityRoles[i], _accountRoles[i]);
            }
        }
    }

    /** Add seller's facilitator.
     *
     * Another entity with seller role can act as a facilitator for the seller.
     * This function enables the facilitator to act on behalf of the seller.
     *
     * Emits an AssociatedEntityAdded event for each added facilitator if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not the entity's admin
     * - Facilitator does not have a seller role
     * - Facilitator is already a facilitator for the seller
     *
     * @dev Pausing modifier is enforced via `addOrRemoveAssociatedEntities`
     *
     * @param _sellerId - the seller's entity ID
     * @param _facilitatorIds - the facilitator's entity IDs
     */
    function addFacilitators(uint256 _sellerId, uint256[] calldata _facilitatorIds) external {
        addOrRemoveAssociatedEntities(FermionTypes.AssociatedRole.Facilitator, _sellerId, _facilitatorIds, true);
    }

    /** Remove seller's facilitator.
     *
     * Removes the facilitator's ability to act on behalf of the seller.
     *
     * Emits an AssociatedEntityRemoved event for each facilitator if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not the entity's admin
     *
     * @dev Pausing modifier is enforced via `addOrRemoveAssociatedEntities`
     *
     * @param _sellerId - the seller's entity ID
     * @param _facilitatorIds - the facilitator's entity IDs
     */
    function removeFacilitators(uint256 _sellerId, uint256[] calldata _facilitatorIds) external {
        addOrRemoveAssociatedEntities(FermionTypes.AssociatedRole.Facilitator, _sellerId, _facilitatorIds, false);
    }

    /** Add seller's allowed royalty recipients.
     *
     * When creating an offer, only the allowed royalty recipients can be set as the recipients.
     *
     * Emits an AssociatedEntityAdded event for each added royalty recipient if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not the entity's admin
     * - Royalty recipient is already set as a royalty recipient for the seller
     *
     * @dev Pausing modifier is enforced via `addOrRemoveAssociatedEntities`
     *
     * @param _sellerId - the seller's entity ID
     * @param _royaltyRecipientIds - the royalty recipient's entity IDs
     */
    function addRoyaltyRecipients(uint256 _sellerId, uint256[] calldata _royaltyRecipientIds) external {
        addOrRemoveAssociatedEntities(
            FermionTypes.AssociatedRole.RoyaltyRecipient,
            _sellerId,
            _royaltyRecipientIds,
            true
        );
    }

    /** Remove seller's allowed royalty recipients.
     *
     * Emits an AssociatedEntityRemoved event for each removed royalty recipient if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not the entity's admin
     *
     * @dev Pausing modifier is enforced via `addOrRemoveAssociatedEntities`
     *
     * @param _sellerId - the seller's entity ID
     * @param _royaltyRecipientIds - the royalty recipient's entity IDs
     */
    function removeRoyaltyRecipients(uint256 _sellerId, uint256[] calldata _royaltyRecipientIds) external {
        addOrRemoveAssociatedEntities(
            FermionTypes.AssociatedRole.RoyaltyRecipient,
            _sellerId,
            _royaltyRecipientIds,
            false
        );
    }

    /**
     * @notice Allows a wallet to renounce one of its account roles for a specific entity role.
     *
     * Emits an EntityAccountRemoved event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller does not have the specified account role for the specified entity role
     * - Caller has an entity-wide role for the specified account role (entity-wide roles, including entity admins, cannot be renounced through this function)
     *
     * @param _entityId - the entity ID
     * @param _entityRole - the entity role for which to renounce the account role
     * @param _accountRole - the account role to renounce
     */
    function renounceAccountRole(
        uint256 _entityId,
        FermionTypes.EntityRole _entityRole,
        FermionTypes.AccountRole _accountRole
    ) external notPaused(FermionTypes.PausableRegion.Entity) nonReentrant {
        address msgSender = _msgSender();

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        EntityLib.validateEntityId(_entityId, pl);

        if (EntityLib.hasAccountRole(_entityId, msgSender, _entityRole, _accountRole, true)) {
            revert ChangeNotAllowed();
        }

        EntityLib.validateAccountRole(_entityId, msgSender, _entityRole, _accountRole);

        FermionStorage.ProtocolEntities storage pe = FermionStorage.protocolEntities();

        // Instead of using getCompactAccountRole, directly calculate the role mask
        uint256 accountRole = 1 << uint256(_accountRole);
        uint256 compactAccountRole = accountRole << (uint256(_entityRole) * BYTE_SIZE);
        EntityLib.storeCompactAccountRole(_entityId, msgSender, compactAccountRole, false, pl, pe);

        // Emit event
        FermionTypes.EntityRole[] memory entityRoles = new FermionTypes.EntityRole[](1);
        entityRoles[0] = _entityRole;
        FermionTypes.AccountRole[][] memory accountRoles = new FermionTypes.AccountRole[][](1);
        accountRoles[0] = new FermionTypes.AccountRole[](1);
        accountRoles[0][0] = _accountRole;
        emit EntityAccountRemoved(_entityId, msgSender, entityRoles, accountRoles);
    }

    /**
     * @notice Add entity wide admin account.
     *
     * This is different from adding a account with manager role for each entity role.
     * The account is given the manager role for all entity roles, even for roles that do not exist yet.
     * A account can be an entity-wide admin for only one entity. This is not checked here, but
     * only when the new admin makes its first entity admin action.
     *
     * Emits an AdminPending event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not the entity's admin
     *
     * @dev Pausing modifier is enforced via `validateAdmin`
     *
     * @param _entityId - the entity ID
     * @param _account - the admin account address
     */
    function setAdmin(uint256 _entityId, address _account) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        EntityLib.validateEntityId(_entityId, pl);
        validateAdmin(_entityId, pl);

        // set the pending admin
        pl.entityLookups[_entityId].pendingAdmin = _account;

        emit AdminPending(_entityId, _account);
    }

    /**
     * @notice Change the account address, i.e. transfers all account roles to the new address.
     *
     * If the account is the entity's admin, it cannot change using this function.
     * It should use setAdmin to set a new account and then revoke the old admin.
     *
     * If the account is used for multiple entities, the change will affect all entities.
     * If you want to change the account only for one entity, you need to remove the account from the entity
     * and add it again with the new address.
     *
     * Emits an AccountChanged event if successful.
     *
     * Reverts if:
     * - Entity region is paused
     * - New and old account are the same
     * - Caller is the entity's admin
     * - Caller is not a account for any entity
     * - New account is already a account for an entity
     *
     * @param _newAccount - the new account address
     */
    function changeAccount(address _newAccount) external notPaused(FermionTypes.PausableRegion.Entity) nonReentrant {
        address msgSender = _msgSender();
        if (msgSender == _newAccount) revert NewAccountSameAsOld();

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 entityId = pl.entityId[msgSender];

        if (entityId != 0) revert ChangeNotAllowed(); // to change the entity admin, use setAdmin and then revoke the old admin

        uint256 accountId = pl.accountId[msgSender];
        if (accountId == 0) revert NoSuchEntity(0);
        delete pl.accountId[msgSender];

        if (pl.accountId[_newAccount] != 0) revert AccountAlreadyExists(_newAccount);
        pl.accountId[_newAccount] = accountId;

        emit AccountChanged(msgSender, _newAccount);
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
     * @dev Pausing modifier is enforced via `validateAdmin`
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
        validateAdmin(_entityId, pl);
        FermionTypes.EntityData storage entityData = EntityLib.fetchEntityData(_entityId);

        EntityLib.storeEntity(_entityId, address(0), entityData, _roles, _metadata);
    }

    /**
     * @notice Updates the owner of the wrapper contract, associated with the offer id
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not the entity admin
     * - New owner is not the seller's assistant or facilitator
     *
     * @dev Pausing modifier is enforced via `validateAdmin`
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
        validateAdmin(entityId, pl);

        EntityLib.validateSellerAssistantOrFacilitator(entityId, offer.facilitatorId, _newOwner);

        wrapperAddress.transferOwnership(_newOwner);
    }

    /**
     * @notice Gets the details about the entity.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _adminAccount - the address of the entity's admin
     * @return entityId - the entity ID
     * @return roles - the roles the entity has
     * @return metadataURI - the metadata URI for the entity
     */
    function getEntity(
        address _adminAccount
    ) external view returns (uint256 entityId, FermionTypes.EntityRole[] memory roles, string memory metadataURI) {
        FermionTypes.EntityData storage entityData;
        (entityId, entityData) = EntityLib.fetchEntityData(_adminAccount);

        roles = EntityLib.compactRoleToRoles(entityData.roles);
        metadataURI = entityData.metadataURI;
    }

    /**
     * @notice Gets the details about the entity.
     *
     * Reverts if:
     * - Entity does not exist
     *
     * @param _entityId - the entity ID
     * @return adminAccount - the address of the entity's admin
     * @return roles - the roles the entity has
     * @return metadataURI - the metadata URI for the entity
     */
    function getEntity(
        uint256 _entityId
    ) external view returns (address adminAccount, FermionTypes.EntityRole[] memory roles, string memory metadataURI) {
        FermionTypes.EntityData storage entityData = EntityLib.fetchEntityData(_entityId);
        adminAccount = entityData.admin;
        roles = EntityLib.compactRoleToRoles(entityData.roles);
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
     * @return status - the facilitator's status
     */
    function isSellersFacilitator(uint256 _sellerId, uint256 _facilitatorId) external view returns (bool status) {
        return FermionStorage.protocolLookups().sellerLookups[_sellerId].isSellersFacilitator[_facilitatorId];
    }

    /** Returns the list of seller's allowlisted royalty recipients.
     *
     * @param _sellerId - the seller's entity ID
     * @return royaltyRecipientIds - the royalty recipient entity IDs
     */
    function getSellersRoyaltyRecipients(
        uint256 _sellerId
    ) external view returns (uint256[] memory royaltyRecipientIds) {
        return FermionStorage.protocolLookups().sellerLookups[_sellerId].sellerRoyaltyRecipients;
    }

    /** Tells if the entity is seller's allowlisted royalty recipient.
     *
     * @param _sellerId - the seller's entity ID
     * @param _royaltyRecipientId - the royalty recipient's entity ID
     * @return status - the royalty recipient's status
     */
    function isSellersRoyaltyRecipient(
        uint256 _sellerId,
        uint256 _royaltyRecipientId
    ) external view returns (bool status) {
        return FermionStorage.protocolLookups().sellerLookups[_sellerId].isSellersRoyaltyRecipient[_royaltyRecipientId];
    }

    /**
     * @notice Tells if a account has a specific account role for entity id and its role.
     *
     * @param _entityId - the entity ID
     * @param _accountAddress - the address of the account
     * @param _entityRole - the role of the entity
     * @param _accountRole - the account role
     */
    function hasAccountRole(
        uint256 _entityId,
        address _accountAddress,
        FermionTypes.EntityRole _entityRole,
        FermionTypes.AccountRole _accountRole
    ) external view returns (bool) {
        return EntityLib.hasAccountRole(_entityId, _accountAddress, _entityRole, _accountRole, false);
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
     * @notice Converts array of permissions to compact account roles.
     *
     * Calculates the compact account roles as the sum of individual account roles.
     * Use "or" to get the correct value even if the same role is specified more than once.
     *
     * @param _accountRole - the array of account roles
     * @return compactAccountRole - the compact representation of account roles
     */
    function accountRoleToCompactAccountRole(
        FermionTypes.AccountRole[] calldata _accountRole
    ) internal pure returns (uint256 compactAccountRole) {
        if (_accountRole.length == 0) {
            return WALLET_ROLE_MASK;
        }

        for (uint256 i = 0; i < _accountRole.length; i++) {
            uint256 accountRole = 1 << uint256(_accountRole[i]);
            compactAccountRole |= accountRole;
        }
    }

    /**
     * @notice Calculates the compact account role for the entity and account.
     *
     * Calculates the complete compact account role (for all entity roles)
     * as the sum of individual comapct account roles (fot each entity role)
     * Each individual compact account role is stored in a separate byte (one byte per entity role)
     *
     * @param _entityId - the entity ID
     * @param _compactEntityRoles - the compact representation of entity roles
     * @param _entityRoles - the array of entity roles
     * @param _accountRoles - the array of account roles
     * @return compactAccountRole - the compact representation of account roles
     */
    function getCompactAccountRole(
        uint256 _entityId,
        uint256 _compactEntityRoles,
        FermionTypes.EntityRole[] calldata _entityRoles,
        FermionTypes.AccountRole[][] calldata _accountRoles
    ) internal view returns (uint256 compactAccountRole) {
        address msgSender = _msgSender();

        if (_entityRoles.length == 0) {
            if (_accountRoles.length != 1) revert FermionGeneralErrors.ArrayLengthMismatch(1, _accountRoles.length);

            // To set entity-wide account roles, the caller must have entity-wide manager role
            if (
                !EntityLib.hasAccountRole(_entityId, msgSender, ANY_ENTITY_ROLE, FermionTypes.AccountRole.Manager, true)
            ) revert NotEntityWideRole(msgSender, _entityId, FermionTypes.AccountRole.Manager);

            uint256 compactAccountRolePerEntityRole = accountRoleToCompactAccountRole(_accountRoles[0]);
            compactAccountRole = compactAccountRolePerEntityRole << (31 * BYTE_SIZE); // put in the first byte.
        } else {
            if (_entityRoles.length != _accountRoles.length)
                revert FermionGeneralErrors.ArrayLengthMismatch(_entityRoles.length, _accountRoles.length);
            for (uint256 i = 0; i < _entityRoles.length; i++) {
                FermionTypes.EntityRole entityRole = _entityRoles[i];
                // Check that the entity has the role
                EntityLib.validateEntityRole(_entityId, _compactEntityRoles, entityRole);

                if (
                    !EntityLib.hasAccountRole(_entityId, msgSender, entityRole, FermionTypes.AccountRole.Manager, false)
                ) revert NotRoleManager(msgSender, _entityId, entityRole);

                uint256 compactAccountRolePerEntityRole = accountRoleToCompactAccountRole(_accountRoles[i]);

                uint256 role = compactAccountRolePerEntityRole << (uint256(entityRole) * BYTE_SIZE); // put in the right byte.
                compactAccountRole |= role;
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
    function validateAdmin(
        uint256 _entityId,
        FermionStorage.ProtocolLookups storage pl
    ) internal notPaused(FermionTypes.PausableRegion.Entity) nonReentrant returns (address) {
        address msgSender = _msgSender();
        uint256 callerEntityId = pl.entityId[msgSender];
        if (callerEntityId == 0) {
            // Try to accept the admin role
            acceptAdminRole(_entityId, msgSender, pl);
        } else {
            if (callerEntityId != _entityId) revert NotAdmin(_entityId, msgSender);
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
    function acceptAdminRole(uint256 _entityId, address _account, FermionStorage.ProtocolLookups storage pl) internal {
        FermionStorage.EntityLookups storage entityLookups = pl.entityLookups[_entityId];
        if (entityLookups.pendingAdmin != _account) revert NotAdmin(_entityId, _account);

        delete entityLookups.pendingAdmin;

        FermionTypes.EntityData storage entityData = EntityLib.fetchEntityData(_entityId);
        address previousAdmin = entityData.admin;
        delete pl.entityId[previousAdmin];

        entityData.admin = _account;
        pl.entityId[_account] = _entityId;

        // add new admin account
        EntityLib.storeCompactAccountRole(
            _entityId,
            _account,
            0xff << (31 * BYTE_SIZE),
            true,
            pl,
            FermionStorage.protocolEntities()
        ); // compact role for all current and potential future roles

        // strip old account of all privileges
        EntityLib.storeCompactAccountRole(
            _entityId,
            previousAdmin,
            0xff << (31 * BYTE_SIZE),
            false,
            pl,
            FermionStorage.protocolEntities()
        );

        EntityLib.emitManagerAccountAddedOrRemoved(_entityId, _account, true);
        EntityLib.emitManagerAccountAddedOrRemoved(_entityId, previousAdmin, false);
    }

    /** Remove seller's associated roles (facilitators or royalty recipients).
     *
     * Reverts if:
     * - Entity region is paused
     * - Entity does not exist
     * - Caller is not the entity's admin
     * - When adding a facilitator, if does not have a seller role
     *
     * @dev Pausing modifier is enforced via `validateAdmin`
     *
     * @param _associatedRole - the associated role
     * @param _sellerId - the seller's entity ID
     * @param _associatedEntitiesIds - the associated entities' IDs
     * @param _add - if true, the facilitator is added, if false, it is removed
     */
    function addOrRemoveAssociatedEntities(
        FermionTypes.AssociatedRole _associatedRole,
        uint256 _sellerId,
        uint256[] calldata _associatedEntitiesIds,
        bool _add
    ) internal {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        EntityLib.validateEntityId(_sellerId, pl);
        validateAdmin(_sellerId, pl);

        (
            uint256[] storage associatedEntities,
            mapping(uint256 => bool) storage isAssociatedRole
        ) = getAssociatedLookups(_sellerId, _associatedRole, pl);

        mapping(uint256 => FermionTypes.EntityData) storage entityData = FermionStorage.protocolEntities().entityData;
        bool found;
        for (uint256 i; i < _associatedEntitiesIds.length; ++i) {
            uint256 associatedEntityId = _associatedEntitiesIds[i];
            if (_add) {
                if (isAssociatedRole[associatedEntityId])
                    revert AssociatedEntityAlreadyExists(_associatedRole, _sellerId, associatedEntityId);

                EntityLib.validateEntityRole(
                    associatedEntityId,
                    entityData[associatedEntityId].roles,
                    _associatedRole == FermionTypes.AssociatedRole.Facilitator
                        ? FermionTypes.EntityRole.Seller
                        : FermionTypes.EntityRole.RoyaltyRecipient
                );

                associatedEntities.push(associatedEntityId);

                emit AssociatedEntityAdded(_associatedRole, _sellerId, associatedEntityId);
            } else {
                uint256 facilitatorsLength = associatedEntities.length;
                for (uint256 j; j < facilitatorsLength; ++j) {
                    if (associatedEntities[j] == associatedEntityId) {
                        unchecked {
                            if (j != facilitatorsLength - 1)
                                associatedEntities[j] = associatedEntities[facilitatorsLength - 1];
                        }
                        associatedEntities.pop();
                        found = true;
                        // stack too deep workaround
                        _emitAssociatedEntityRemoved(_associatedRole, _sellerId, associatedEntityId);
                        break;
                    }
                }
            }

            isAssociatedRole[associatedEntityId] = _add;
        }
        if (!_add && !found) revert NoEntitiesModified(_associatedRole, _sellerId);
    }

    function _emitAssociatedEntityRemoved(
        FermionTypes.AssociatedRole _associatedRole,
        uint256 _sellerId,
        uint256 _associatedEntityId
    ) private {
        emit AssociatedEntityRemoved(_associatedRole, _sellerId, _associatedEntityId);
    }

    /** Returns the storage pointers to associated entities and the mapping of the associated role.
     *
     * @param _associatedRole - the associated role
     * @param _sellerId - the seller's entity ID
     * @param pl - the protocol lookups
     * @return associatedEntities - the associated entities
     * @return isAssociatedRole - the mapping of the associated role
     */
    function getAssociatedLookups(
        uint256 _sellerId,
        FermionTypes.AssociatedRole _associatedRole,
        FermionStorage.ProtocolLookups storage pl
    ) internal view returns (uint256[] storage associatedEntities, mapping(uint256 => bool) storage isAssociatedRole) {
        FermionStorage.SellerLookups storage sellerLookups = pl.sellerLookups[_sellerId];
        if (_associatedRole == FermionTypes.AssociatedRole.Facilitator) {
            associatedEntities = sellerLookups.sellerFacilitators;
            isAssociatedRole = sellerLookups.isSellersFacilitator;
        } else {
            associatedEntities = sellerLookups.sellerRoyaltyRecipients;
            isAssociatedRole = sellerLookups.isSellersRoyaltyRecipient;
        }
    }
}
