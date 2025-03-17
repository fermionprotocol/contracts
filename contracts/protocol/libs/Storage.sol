// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { IBosonProtocol } from "../interfaces/IBosonProtocol.sol";

/**
 * @title FermionStorage
 *
 * @notice Provides access to the protocol storage
 */
library FermionStorage {
    // keccak256(abi.encode(uint256(keccak256("fermion.protocol.status")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant PROTOCOL_STATUS_POSITION =
        0x3144091ebb938ccd9d751b466db575a8de4d70fb2eb8b40620da838c2583fa00;
    // keccak256(abi.encode(uint256(keccak256("fermion.protocol.config")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant PROTOCOL_CONFIG_POSITION =
        0x6ef45f7257a99921155f075ce9a6791d74a06c7aef2321d25e643f688d1e3d00;
    // keccak256(abi.encode(uint256(keccak256("fermion.protocol.entities")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant PROTOCOL_ENTITIES_POSITION =
        0x88d4ceef162f03fe6cb4afc6ec9059995e2e55e4c807661ebd7d646b852a9700;
    // keccak256(abi.encode(uint256(keccak256("fermion.protocol.lookups")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant PROTOCOL_LOOKUPS_POSITION =
        0x769aa294c8d03dc2ae011ff448d15e722e87cfb823b4b4d6339267d1c690d900;
    // keccak256(abi.encode(uint256(keccak256("fermion.meta.transaction")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant META_TRANSACTION_POSITION =
        0x1b00ae0f5ca50b57738405440d11dc84d7b23d830f08bc0a651be8df02efae00;
    // keccak256(abi.encode(uint256(keccak256("fermion.price.oracle.registry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PRICE_ORACLE_REGISTRY_STORAGE_POSITION =
        0xf3e4b6e521454dd4d56ea49cf25ff76edb944d588972b9362ced848f4db54500;

    // Protocol status storage
    /// @custom:storage-location erc7201:fermion.protocol.status
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

    // Protocol config storage
    /// @custom:storage-location erc7201:fermion.protocol.config
    struct ProtocolConfig {
        // Protocol treasury address
        address payable treasury;
        // Default Protocol fee
        uint16 protocolFeePercentage;
        // OpenSea fee percentage
        uint16 openSeaFeePercentage;
        // Default verification timeout
        uint256 defaultVerificationTimeout;
        // Max verification timeout
        uint256 maxVerificationTimeout;
        // Token-specific fee tables
        mapping(address => uint256[]) tokenPriceRanges; // Price ranges for each token
        mapping(address => uint16[]) tokenFeePercentages; // Fee percentages for each price range
    }

    // Protocol entities storage
    /// @custom:storage-location erc7201:fermion.protocol.entities
    struct ProtocolEntities {
        // entity id => entity data
        mapping(uint256 => FermionTypes.EntityData) entityData;
        // account id => entity id => account permissions (compact)
        mapping(uint256 => mapping(uint256 => uint256)) accountRole;
        // offer id => fermion properties
        mapping(uint256 => FermionTypes.Offer) offer;
    }

    // Protocol lookup storage
    /// @custom:storage-location erc7201:fermion.protocol.lookups
    struct ProtocolLookups {
        // entity counter
        uint256 entityCounter;
        // accounts counter
        uint256 accountsCounter;
        // entity admin => entity id
        mapping(address => uint256) entityId;
        // account => account id
        mapping(address => uint256) accountId;
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
        // unwraping function storage slot
        mapping(FermionTypes.WrapType => function(
            uint256,
            IBosonProtocol.PriceDiscovery memory,
            address,
            bytes memory
        )) deriveAndValidatePriceDiscoveryData;
    }

    struct EntityLookups {
        // pending entity admin
        address pendingAdmin;
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
        uint256 itemQuantity;
        uint256 firstTokenId;
        // custodian update request
        FermionTypes.CustodianUpdateRequest custodianUpdateRequest;
    }

    struct TokenLookups {
        // item full price
        uint256 itemPrice;
        // checkout request
        FermionTypes.CheckoutRequest checkoutRequest;
        // vault amount
        FermionTypes.CustodianFee vault;
        // verification timeout
        uint256 itemVerificationTimeout;
        // max verification timeout
        uint256 itemMaxVerificationTimeout;
        // fees
        uint256 bosonProtocolFee;
        uint256 fermionFeeAmount;
        uint256 verifierFee;
        uint256 facilitatorFeeAmount;
        // revised metadata
        string revisedMetadata;
        // buyer payout when the item is revised
        uint16 sellerSplitProposal;
        uint16 buyerSplitProposal;
        // initial buyer
        address initialBuyer;
        // pyhgitals
        FermionTypes.Phygital[] phygitals;
        // phygitals recipient
        uint256 phygitalsRecipient;
        // custom item price used only in case of forceful fractionalisation
        uint256 selfSaleItemPrice;
    }

    struct SellerLookups {
        // facilitator id => status
        mapping(uint256 => bool) isSellersFacilitator;
        // list of facilitators
        uint256[] sellerFacilitators;
    }

    // Storage related to Meta Transactions
    /// @custom:storage-location erc7201:fermion.meta.transaction
    struct MetaTransaction {
        // The address of the protocol contract
        address fermionAddress;
        // address => nonce => nonce used indicator
        mapping(address => mapping(uint256 => bool)) usedNonce;
        // Can function be executed using meta transactions
        mapping(bytes32 => bool) isAllowlisted;
    }

    // Storage related to Price Oracle Registry
    /// @custom:storage-location erc7201:fermion.price.oracle.registry
    struct PriceOracleRegistryStorage {
        // oracle address => identifier (e.g GOLD, REAL_ESTATE, ROLEX_REF214325)
        mapping(address => bytes32) priceOracles;
    }

    /**
     * @notice Gets the protocol status slot
     *
     * @return ps - the protocol status slot
     */
    function protocolStatus() internal pure returns (ProtocolStatus storage ps) {
        assembly {
            ps.slot := PROTOCOL_STATUS_POSITION
        }
    }

    /**
     * @notice Gets the protocol config slot
     *
     * @return pc - the protocol config slot
     */
    function protocolConfig() internal pure returns (ProtocolConfig storage pc) {
        assembly {
            pc.slot := PROTOCOL_CONFIG_POSITION
        }
    }

    /**
     * @notice Gets the protocol entities slot
     *
     * @return pe - the protocol entities slot
     */
    function protocolEntities() internal pure returns (ProtocolEntities storage pe) {
        assembly {
            pe.slot := PROTOCOL_ENTITIES_POSITION
        }
    }

    /**
     * @notice Gets the protocol lookups slot
     *
     * @return pl - the protocol lookups slot
     */
    function protocolLookups() internal pure returns (ProtocolLookups storage pl) {
        assembly {
            pl.slot := PROTOCOL_LOOKUPS_POSITION
        }
    }

    /**
     * @notice Gets the meta transaction slot
     *
     * @return mt - the meta transaction slot
     */
    function metaTransaction() internal pure returns (MetaTransaction storage mt) {
        assembly {
            mt.slot := META_TRANSACTION_POSITION
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

    /**
     * @notice Gets the price oracle registry storage slot.
     *
     * @return storageRef - the price oracle registry storage
     */
    function priceOracleRegistryStorage() internal pure returns (PriceOracleRegistryStorage storage storageRef) {
        assembly {
            storageRef.slot := PRICE_ORACLE_REGISTRY_STORAGE_POSITION
        }
    }
}
