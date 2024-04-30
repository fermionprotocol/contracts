// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IEntityEvents
 *
 * @notice Defines events related to management of entites within the protocol.
 */
interface IEntityEvents {
    event EntityStored(address indexed wallet, FermionTypes.EntityRole[] roles, string metadata);
    event EntityActorAdded(
        uint256 indexed _entityId,
        address indexed _actorWallet,
        FermionTypes.EntityRole[] _actorRoles,
        FermionTypes.EntityActor[] _actorTypes
    );
}
