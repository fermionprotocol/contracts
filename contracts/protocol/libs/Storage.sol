// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";

/**
 * @title FermionStorage
 *
 * @notice Provides access to the protocol storage
 */
library FermionStorage {
    bytes32 internal constant PROTOCOL_ENTITIES_POSITION = keccak256("fermion.protocol.entities");

    // Protocol entities storage
    struct ProtocolEntities {
        // address => entity data
        mapping(address => FermionTypes.EntityData) entityData;
    }

    /**
     * @notice Gets the protocol entities slot
     *
     * @return pe - the protocol entities slot
     */
    function protocolEntities() internal pure returns (ProtocolEntities storage pe) {
        bytes32 position = PROTOCOL_ENTITIES_POSITION;
        assembly {
            pe.slot := position
        }
    }
}
