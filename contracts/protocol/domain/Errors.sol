// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "./Types.sol";

interface FermionErrors {
    // General errors
    error InvalidAddress();
    error ArrayLengthMismatch(uint256 array1Length, uint256 array2Length);

    // Initialization errors
    error DirectInitializationNotAllowed();
    error VersionMustBeSet();
    error AddressesAndCalldataLengthMismatch(uint256 addressesLength, uint256 calldataLength);

    // Entity errors
    error InvalidEntityRoles();
    error EntityAlreadyExists();
    error NoSuchEntity();
    error NotAdmin(uint256 entityId, address admin);
    error NotPendingAdmin(uint256 entityId, address admin);
    error AlreadyAdmin(uint256 entityId, address admin);
    error EntityHasNoRole(uint256 entityId, FermionTypes.EntityRole role);

    // Meta transaction errors
    error NonceUsedAlready();
    error FunctionNotAllowlisted();
    error InvalidFunctionName();
    error InvalidSignature();
    error SignerAndSignatureDoNotMatch();
    error FunctionCallFailed();
}
