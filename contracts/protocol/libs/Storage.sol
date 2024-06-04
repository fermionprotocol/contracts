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
    bytes32 internal constant PROTOCOL_LOOKUPS_POSITION = keccak256("fermion.protocol.lookups");
    bytes32 internal constant META_TRANSACTION_POSITION = keccak256("fermion.meta.transaction");

    struct ProtocolStatus {
        // Current protocol version
        bytes32 version;
        // Boson seller id
        uint256 bosonSellerId;
        // Boson NFT collection address
        address bosonNftCollection;
        // Beacon for wrapper implementation
        address wrapperBeacon;
        // Beacon proxy, which uses wrapperBeacon
        address wrapperBeaconProxy;
    }

    // Protocol entities storage
    struct ProtocolEntities {
        // entity id => entity data
        mapping(uint256 => FermionTypes.EntityData) entityData;
        // wallet id => entity id => wallet permissions (compact)
        mapping(uint256 => mapping(uint256 => uint256)) walletRole;
        // offer id => fermion properties
        mapping(uint256 => FermionTypes.Offer) offer;
    }

    // Protocol lookup storage
    struct ProtocolLookups {
        // entity counter
        uint256 entityCounter;
        // wallets counter
        uint256 walletsCounter;
        // entity admin => entity id
        mapping(address => uint256) entityId;
        // wallet => wallet id
        mapping(address => uint256) walletId;
        // entity id => entity admin => pending status
        mapping(uint256 => mapping(address => bool)) pendingEntityAdmin;
        // offerId => wrapper address
        mapping(uint256 => address) wrapperAddress;
        // offerId => offerPrice
        mapping(uint256 => uint256) offerPrice;
        // entity id => token address => amount
        mapping(uint256 => mapping(address => uint256)) availableFunds;
        // entity id => all tokens with balance > 0
        mapping(uint256 => address[]) tokenList;
        // account id => token address => index on token addresses list
        mapping(uint256 => mapping(address => uint256)) tokenIndexByAccount;
        // token id => checkout request
        mapping(uint256 => FermionTypes.CheckoutRequest) checkoutRequest;
        // seller id => facilitator id => status
        mapping(uint256 => mapping(uint256 => bool)) isSellersFacilitator;
        // seller id => list of facilitators
        mapping(uint256 => uint256[]) sellerFacilitators;
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

    /**
     * @notice Gets the offer from the token id
     *
     * @param _tokenId - the token id
     * @return offerId - the offer id
     * @return offer storage pointer
     */
    function getOfferFromTokenId(
        uint256 _tokenId
    ) internal view returns (uint256 offerId, FermionTypes.Offer storage offer) {
        offerId = _tokenId >> 128;
        offer = protocolEntities().offer[offerId];
    }
}
