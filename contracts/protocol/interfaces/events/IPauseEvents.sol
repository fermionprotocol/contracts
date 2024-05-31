// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IPauseEvents
 *
 * @notice Defines events related to pauseing of the protocol.
 */
interface IPauseEvents {
    // When array of regions is empty, all regions are paused
    event ProtocolPaused(FermionTypes.PausableRegion[] regions);
    // When array of regions is empty, all regions are unpaused
    event ProtocolUnpaused(FermionTypes.PausableRegion[] regions);
}
