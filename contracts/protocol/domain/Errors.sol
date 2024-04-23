// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

interface FermionErrors {
    // Initialization errors
    error DirectInitializationNotAllowed();
    error VersionMustBeSet();
    error AddressesAndCalldataLengthMismatch();

    error InvalidEntityRoles();
    error EntityAlreadyExists();
    error NoSuchEntity();
}
