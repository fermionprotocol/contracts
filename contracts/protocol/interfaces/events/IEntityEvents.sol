// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IEntityEvents
 *
 * @notice Defines events related to management of entites within the protocol.
 */
interface IEntityEvents {
    event EntityStored(
        uint256 indexed entityId,
        address indexed adminAccount,
        FermionTypes.EntityRole[] roles,
        string metadata
    );
    event EntityAccountAdded(
        uint256 indexed entityId,
        address indexed account,
        FermionTypes.EntityRole[] entityRoles,
        FermionTypes.AccountRole[][] accountRole
    );
    event EntityAccountRemoved(
        uint256 indexed entityId,
        address indexed account,
        FermionTypes.EntityRole[] entityRoles,
        FermionTypes.AccountRole[][] accountRole
    );
    event AccountChanged(address indexed oldAccount, address indexed newAccount);
    event AssociatedEntityAdded(
        FermionTypes.AssociatedRole associatedRole,
        uint256 indexed entityId,
        uint256 indexed associatedEntityIds
    );
    event AssociatedEntityRemoved(
        FermionTypes.AssociatedRole associatedRole,
        uint256 indexed entityId,
        uint256 indexed associatedEntityIds
    );
    event AdminPending(uint256 indexed entityId, address indexed account);
}
