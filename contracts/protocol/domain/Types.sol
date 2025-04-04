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
    enum AccountRole {
        Manager,
        Assistant,
        Treasury
    }

    enum VerificationStatus {
        Verified,
        Rejected
    }

    enum CheckoutRequestStatus {
        None,
        CheckedIn,
        CheckOutRequested,
        CheckOutRequestCleared,
        CheckedOut
    }

    enum PausableRegion {
        Config,
        MetaTransaction,
        Funds,
        Entity,
        Offer,
        Verification,
        Custody,
        CustodyVault
    }

    enum AuctionState {
        NotStarted,
        Ongoing,
        Reserved,
        Finalized,
        Redeemed
    }

    enum TokenState {
        Inexistent,
        Wrapped,
        Unwrapping,
        Unverified,
        Verified,
        CheckedIn,
        CheckedOut,
        Burned
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
        CustodianFee custodianFee;
        uint256 facilitatorId;
        uint256 facilitatorFeePercent;
        address exchangeToken;
        string metadataURI;
        string metadataHash;
    }

    struct CustodianFee {
        uint256 amount;
        uint256 period;
    }

    struct CheckoutRequest {
        CheckoutRequestStatus status;
        address buyer;
        uint256 taxAmount;
    }

    struct CustodianVaultParameters {
        uint256 partialAuctionThreshold;
        uint256 partialAuctionDuration;
        uint256 liquidationThreshold;
        uint256 newFractionsPerAuction;
    }

    struct FractionAuction {
        uint256 endTime;
        uint256 availableFractions;
        uint256 maxBid;
        uint256 bidderId;
    }

    // Fermion F-NFT, buyout auction
    struct AuctionDetails {
        uint256 timer;
        uint256 maxBid;
        address maxBidder;
        uint256 totalFractions;
        uint256 lockedFractions;
        uint256 lockedBidAmount;
        AuctionState state;
    }

    struct Votes {
        uint256 total;
        mapping(address => uint256) individual;
    }

    struct BuyoutAuctionStorage {
        uint256 nftCount; // number of fractionalised NFTs
        address exchangeToken;
        BuyoutAuctionParameters auctionParameters;
        uint256 pendingRedeemableSupply; // for tokens that auction started but not finalized yet
        uint256 unrestricedRedeemableSupply;
        uint256 unrestricedRedeemableAmount;
        uint256 lockedRedeemableSupply;
        mapping(uint256 => TokenAuctionInfo) tokenInfo;
    }

    struct TokenAuctionInfo {
        bool isFractionalised;
        Auction[] auctions;
        int256[] lockedProceeds; // locked for users that voted to start
    }

    struct BuyoutAuctionParameters {
        uint256 exitPrice;
        uint256 duration; // in seconds; if zero, the default value is used
        uint256 unlockThreshold; // in percents; if zero, the default value is used
        uint256 topBidLockTime; // in seconds; if zero, the default value is used
    }

    struct Auction {
        AuctionDetails details;
        Votes votes;
    }
}
