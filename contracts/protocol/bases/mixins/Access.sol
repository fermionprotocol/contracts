// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { FermionTypes } from "../../domain/Types.sol";
import { FermionStorage } from "../../libs/Storage.sol";
import { PauseErrors } from "../../domain/Errors.sol";
import { Context } from "../../bases/mixins/Context.sol";
import { ReentrancyGuard } from "../../bases/mixins/ReentrancyGuard.sol";

/**
 * @title Access control
 *
 * @notice Provides access to the protocol
 */
contract Access is Context, ReentrancyGuard {
    struct RoleData {
        mapping(address account => bool) hasRole;
        bytes32 adminRole;
    }

    struct AccessControlStorage {
        mapping(bytes32 role => RoleData) _roles;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.AccessControl")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant AccessControlStorageLocation =
        0x02dd7bc7dec4dceedda775e58dd541e08a116c6c53815c0bd028192f7b626800;

    function _getAccessControlStorage() private pure returns (AccessControlStorage storage $) {
        assembly {
            $.slot := AccessControlStorageLocation
        }
    }

    modifier onlyRole(bytes32 _role) {
        address account = _msgSender();

        if (!_getAccessControlStorage()._roles[_role].hasRole[account])
            revert IAccessControl.AccessControlUnauthorizedAccount(account, _role);
        _;
    }

    modifier notPaused(FermionTypes.PausableRegion _region) {
        // Region enum value must be used as the exponent in a power of 2
        uint256 powerOfTwo = 1 << uint256(_region);
        if ((FermionStorage.protocolStatus().paused & powerOfTwo) == powerOfTwo)
            revert PauseErrors.RegionPaused(_region);
        _;
    }
}
