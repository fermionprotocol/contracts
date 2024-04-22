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
    bytes32 internal constant META_TRANSACTION_POSITION = keccak256("fermion.meta.transaction");

    // Protocol entities storage
    struct ProtocolEntities {
        // address => entity data
        mapping(address => FermionTypes.EntityData) entityData;
    }

    // Storage related to Meta Transactions
    struct MetaTransaction {
        // The domain Separator of the protocol ??
        bytes32 domainSeparator;
        // address => nonce => nonce used indicator
        mapping(address => mapping(uint256 => bool)) usedNonce;
        // The cached chain id ??
        uint256 cachedChainId;
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
