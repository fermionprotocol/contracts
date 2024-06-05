// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "./Storage.sol";
import { FermionErrors } from "../domain/Errors.sol";

/**
 * @title Access control
 *
 * @notice Provides access to the protocol
 */
contract Access {
    modifier onlyAdmin() {
        LibDiamond.enforceIsContractOwner();
        _;
    }

    modifier notPaused(FermionTypes.PausableRegion _region) {
        // Region enum value must be used as the exponent in a power of 2
        uint256 powerOfTwo = 1 << uint256(_region);
        if ((FermionStorage.protocolStatus().paused & powerOfTwo) == powerOfTwo)
            revert FermionErrors.RegionPaused(_region);
        _;
    }
}
