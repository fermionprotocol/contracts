// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";

/**
 * @title FermionStorage
 *
 * @notice Provides access to the protocol storage
 */
library FermionStorage {
    bytes32 internal constant PROTOCOL_STATUS_POSITION = keccak256("fermion.protocol.status");
    bytes32 internal constant PROTOCOL_ENTITIES_POSITION = keccak256("fermion.protocol.entities");

    struct ProtocolStatus {
        // Current protocol version
        bytes32 version;
        // Boson seller id
        uint256 bosonSellerId;
    }

    // Protocol entities storage
    struct ProtocolEntities {
        // address => entity data
        mapping(address => FermionTypes.EntityData) entityData;
    }

    /**
     * @notice Gets the protocol status slot
     *
     * @return ps - the protocol status slot
     */
    function protocolStatus() internal pure returns (ProtocolStatus storage ps) {
        bytes32 position = PROTOCOL_STATUS_POSITION;
        assembly {
            ps.slot := position
        }
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
