// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { PAUSER } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { PauseErrors } from "../domain/Errors.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Access } from "../bases/mixins/Access.sol";
import { IPauseEvents } from "../interfaces/events/IPauseEvents.sol";

/**
 * @title PauseFacet
 *
 * @notice Handles protocol region pausing.
 */
contract PauseFacet is Access, PauseErrors, IPauseEvents {
    uint256 private constant ALL_REGIONS_MASK = (1 << (uint256(type(FermionTypes.PausableRegion).max) + 1)) - 1;

    /**
     * @notice Pauses some or all of the protocol.
     *
     * Emits a ProtocolPaused event if successful.
     *
     * Reverts if:
     * - Caller is not the protocol pauser
     *
     * @param _regions - an array of regions to pause. See: {FermionTypes.PausableRegion}
     */
    function pause(FermionTypes.PausableRegion[] calldata _regions) external onlyRole(PAUSER) {
        togglePause(_regions, true);

        // Notify watchers of state change
        emit ProtocolPaused(_regions);
    }

    /**
     * @notice Unpauses the protocol.
     *
     * Emits a ProtocolUnpaused event if successful.
     *
     * Reverts if:
     * - Caller is not the protcol pauser
     * - Protocol is not currently paused
     */
    function unpause(FermionTypes.PausableRegion[] calldata _regions) external onlyRole(PAUSER) {
        // Make sure the protocol is paused
        if (FermionStorage.protocolStatus().paused == 0) revert NotPaused();

        togglePause(_regions, false);

        // Notify watchers of state change
        emit ProtocolUnpaused(_regions);
    }

    /**
     * @notice Returns the regions paused
     *
     * @return regions - an array of regions that are currently paused. See: {FermionTypes.PausableRegion}
     */
    function getPausedRegions() external view returns (FermionTypes.PausableRegion[] memory regions) {
        // Cache protocol status for reference
        FermionStorage.ProtocolStatus storage status = FermionStorage.protocolStatus();
        uint256 totalRegions = uint256(type(FermionTypes.PausableRegion).max) + 1;

        regions = new FermionTypes.PausableRegion[](totalRegions);

        // Return all regions if all are paused.
        if (status.paused == ALL_REGIONS_MASK) {
            for (uint256 i = 0; i < totalRegions; i++) {
                regions[i] = FermionTypes.PausableRegion(i);
            }
        } else {
            uint256 count = 0;

            unchecked {
                for (uint256 i = 0; i < totalRegions; i++) {
                    // Check if the region is paused by bitwise AND operation with shifted 1
                    if (status.paused & (1 << i) != 0) {
                        regions[count] = FermionTypes.PausableRegion(i);

                        count++;
                    }
                }
            }

            // setting the correct number of regions
            assembly {
                mstore(regions, count)
            }
        }
    }

    /**
     * @notice Toggles pause/unpause for some or all of the protocol.
     *
     * Toggle all regions if none are specified.
     *
     * @param _regions - an array of regions to pause/unpause. See: {FermionTypes.PausableRegion}
     * @param _pause - a boolean indicating whether to pause (true) or unpause (false)
     */
    function togglePause(FermionTypes.PausableRegion[] calldata _regions, bool _pause) internal {
        // Cache protocol status for reference
        FermionStorage.ProtocolStatus storage fs = FermionStorage.protocolStatus();

        // Toggle all regions if none are specified.
        if (_regions.length == 0) {
            // Store the paused status
            fs.paused = _pause ? ALL_REGIONS_MASK : 0;
            return;
        }

        uint256 incomingPaused;

        // Calculate the incoming paused status as the sum of individual regions
        // Use "or" to get the correct value even if the same region is specified more than once
        unchecked {
            for (uint256 i = 0; i < _regions.length; i++) {
                // Get enum value as power of 2
                incomingPaused |= 1 << uint256(_regions[i]);
            }
        }

        // Store the paused status
        if (_pause) {
            // for pausing, just "or" the incoming paused status with the existing one
            // equivalent to summation
            fs.paused |= incomingPaused;
        } else {
            // for unpausing, "and" the inverse of the incoming paused status with the existing one
            // equivalent to subtraction
            fs.paused &= ~incomingPaused;
        }
    }
}
