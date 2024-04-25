// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

interface FermionErrors {
    // General errors
    error InvalidAddress();

    // Initialization errors
    error DirectInitializationNotAllowed();
    error VersionMustBeSet();
    error AddressesAndCalldataLengthMismatch();

    // Entity errors
    error InvalidEntityRoles();
    error EntityAlreadyExists();
    error NoSuchEntity();

    // Meta transaction errors
    error NonceUsedAlready();
    error FunctionNotAllowlisted();
    error InvalidFunctionName();
    error InvalidSignature();
    error SignerAndSignatureDoNotMatch();
    error FunctionCallFailed();
}
