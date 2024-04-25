// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IInitialziationEvents
 *
 * @notice Defines events related to protocol initialization.
 */
interface IInitialziationEvents {
    event ProtocolInitialized(bytes32 indexed version);
}
