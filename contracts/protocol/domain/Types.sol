// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title FermionTypes
 *
 * @notice Enums and structs used by the Fermion Protocol contract ecosystem.
 */

contract FermionTypes {
    enum EntityRole {
        Seller,
        Buyer,
        Verifier,
        Custodian
    }

    // Make at most 8 roles so they can be compacted into a byte
    enum WalletRole {
        Admin,
        Assistant,
        Treasury
    }

    enum VerificationStatus {
        Verified,
        Rejected
    }

    enum CheckoutRequestStatus {
        None,
        Requested,
        Cleared,
        CheckedOut
    }

    struct EntityData {
        address admin;
        uint256 roles;
        string metadataURI;
    }

    struct MetaTransaction {
        uint256 nonce;
        address from;
        address contractAddress;
        string functionName;
        bytes functionSignature;
    }

    struct Offer {
        uint256 sellerId;
        uint256 sellerDeposit;
        uint256 verifierId;
        uint256 verifierFee;
        uint256 custodianId;
        address exchangeToken;
        string metadataURI;
        string metadataHash;
    }

    struct CheckoutRequest {
        CheckoutRequestStatus status;
        uint256 taxAmount;
    }
}
