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
    bytes32 internal constant PROTOCOL_CONFIG_POSITION = keccak256("fermion.protocol.config");
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
        address fermionFNFTBeacon;
        // Beacon proxy, which uses fermionFNFTBeacon
        address fermionFNFTBeaconProxy;
        // Pause status
        uint256 paused;
    }

    struct ProtocolConfig {
        // Protocol treasury address
        address payable treasury;
        // Protocol fee
        uint16 protocolFeePercentage;
        // Verification timeout
        uint256 verificationTimeout;
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
        // account id => token address => index on token addresses list
        mapping(uint256 => mapping(address => uint256)) tokenIndexByAccount;
        // entity id => entity lookups
        mapping(uint256 => EntityLookups) entityLookups;
        // offer id => offer lookups
        mapping(uint256 => OfferLookups) offerLookups;
        // token id => token lookups
        mapping(uint256 => TokenLookups) tokenLookups;
        // entity id => seller lookups
        mapping(uint256 => SellerLookups) sellerLookups;
    }

    struct EntityLookups {
        // entity admin => pending status
        mapping(address => bool) pendingEntityAdmin;
        // token address => amount
        mapping(address => uint256) availableFunds;
        // all tokens with balance > 0
        address[] tokenList;
    }

    struct OfferLookups {
        // fermion FNFT address
        address fermionFNFTAddress;
        // fraction auction details
        FermionTypes.FractionAuction fractionAuction;
        // custodianVaultParameters
        FermionTypes.CustodianVaultParameters custodianVaultParameters;
        // number of items in custodian vault
        uint256 custodianVaultItems;
    }

    struct TokenLookups {
        // item price
        uint256 itemPrice;
        // checkout request
        FermionTypes.CheckoutRequest checkoutRequest;
        // vault amount
        FermionTypes.CustodianFee vault;
        // verification timeout
        uint256 itemVerificationTimeout;
    }

    struct SellerLookups {
        // facilitator id => status
        mapping(uint256 => bool) isSellersFacilitator;
        // list of facilitators
        uint256[] sellerFacilitators;
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
     * @notice Gets the protocol config slot
     *
     * @return pc - the protocol config slot
     */
    function protocolConfig() internal pure returns (ProtocolConfig storage pc) {
        bytes32 position = PROTOCOL_CONFIG_POSITION;
        assembly {
            pc.slot := position
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
