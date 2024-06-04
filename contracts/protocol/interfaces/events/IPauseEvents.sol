// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IPauseEvents
 *
 * @notice Defines events related to pausing of the protocol.
 */
interface IPauseEvents {
    // `regions` is the list of regions, paused by the transaction, emitting the event.
    // Other regions could be paused from before.
    // When the array of regions is empty, all regions are paused
    event ProtocolPaused(FermionTypes.PausableRegion[] regions);
    // `regions` is the list of regions, unpaused by the transaction, emitting the event.
    // Other regions can remain paused.
    // When the array of regions is empty, all regions are unpaused
    event ProtocolUnpaused(FermionTypes.PausableRegion[] regions);
}
