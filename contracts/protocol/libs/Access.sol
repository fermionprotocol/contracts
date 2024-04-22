// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";

/**
 * @title FermionStorage
 *
 * @notice Provides access to the protocol storage
 */
contract Access {
    modifier onlyAdmin() {
        LibDiamond.enforceIsContractOwner();
        _;
    }
}
