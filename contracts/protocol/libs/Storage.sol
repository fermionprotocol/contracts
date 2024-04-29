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
    bytes32 internal constant PROTOCOL_LOOKUPS_POSITION = keccak256("fermion.protocol.lookups");
    bytes32 internal constant META_TRANSACTION_POSITION = keccak256("fermion.meta.transaction");

    // Protocol entities storage
    struct ProtocolEntities {
        // address => entity data
        mapping(uint256 => FermionTypes.EntityData) entityData;
    }

    // Protocol lookup storage
    struct ProtocolLookups {
        // entity counter
        uint256 entityCounter;
        // entity admin => entity id
        mapping(address => uint256) entityId;
    }

    // Storage related to Meta Transactions
    struct MetaTransaction {
        // The address of the protocol contract
        address fermionAddress;
        // address => nonce => nonce used indicator
        mapping(address => mapping(uint256 => bool)) usedNonce;
        // Can function be executed using meta transactions
        mapping(bytes32 => bool) isAllowlisted;
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

    /**
     * @notice Gets the protocol lookups slot
     *
     * @return pl - the protocol lookups slot
     */
    function protocolLookups() internal pure returns (ProtocolLookups storage pl) {
        bytes32 position = PROTOCOL_LOOKUPS_POSITION;
        assembly {
            pl.slot := position
        }
    }

    /**
     * @notice Gets the meta transaction slot
     *
     * @return mt - the meta transaction slot
     */
    function metaTransaction() internal pure returns (MetaTransaction storage mt) {
        bytes32 position = META_TRANSACTION_POSITION;
        assembly {
            mt.slot := position
        }
    }
}
