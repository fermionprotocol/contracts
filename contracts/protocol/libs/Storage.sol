// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";

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
        // entity id => entity admin => pending status
        mapping(uint256 => mapping(address => bool)) pendingEntityAdmin;
        // offerId => wrapper address
        mapping(uint256 => address) fermionFNFTAddress;
        // tokenId => item price
        mapping(uint256 => uint256) itemPrice;
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
        // token id => vault amount
        mapping(uint256 => FermionTypes.CustodianFee) vault;
        // offer id => fraction auction details
        mapping(uint256 => FermionTypes.FractionAuction) fractionAuction;
        // offer id => custodianVaultParameters
        mapping(uint256 => FermionTypes.CustodianVaultParameters) custodianVaultParameters;
        // offer id => number of items in custodian vault
        mapping(uint256 => uint256) custodianVaultItems;
        // token id => verification timeout
        mapping(uint256 => uint256) itemVerificationTimeout;
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
}
