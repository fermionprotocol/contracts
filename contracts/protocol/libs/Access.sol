// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "./Storage.sol";
import { PauseErrors, FermionGeneralErrors } from "../domain/Errors.sol";
import { Context } from "./Context.sol";
import { ReentrancyGuard } from "./ReentrancyGuard.sol";

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

    /** Checks if the caller is the F-NFT contract owning the token.
     *
     * Reverts if:
     * - The caller is not the F-NFT contract owning the token
     *
     * @param _offerId - offer ID associated with the vault
     * @param pl - the number of tokens to add to the vault
     */
    function verifyFermionFNFTCaller(uint256 _offerId, FermionStorage.ProtocolLookups storage pl) internal view {
        if (msg.sender != pl.offerLookups[_offerId].fermionFNFTAddress)
            revert FermionGeneralErrors.AccessDenied(msg.sender); // not using _msgSender() since the FNFT will never use meta transactions
    }
}
