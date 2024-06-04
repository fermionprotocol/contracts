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
        address indexed adminWallet,
        FermionTypes.EntityRole[] roles,
        string metadata
    );
    event EntityDeleted(uint256 indexed entityId, address indexed adminWallet);
    event EntityWalletAdded(
        uint256 indexed entityId,
        address indexed wallet,
        FermionTypes.EntityRole[] entityRoles,
        FermionTypes.WalletRole[][] walletRole
    );
    event EntityWalletRemoved(
        uint256 indexed entityId,
        address indexed wallet,
        FermionTypes.EntityRole[] entityRoles,
        FermionTypes.WalletRole[][] walletRole
    );
    event WalletChanged(address indexed oldWallet, address indexed newWallet);
    event FacilitatorAdded(uint256 indexed entityId, uint256 indexed facilitatorIds);
    event FacilitatorRemoved(uint256 indexed entityId, uint256 indexed facilitatorIds);
}
