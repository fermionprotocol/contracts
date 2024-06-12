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
        CheckedIn,
        CheckOutRequested,
        CheckOutRequestCleared,
        CheckedOut
    }

    enum PausableRegion {
        MetaTransaction,
        Entity,
        Funds,
        Offer,
        Custody,
        Verification
    }

    enum AuctionState {
        NotStarted,
        Ongoing,
        Finalized,
        Redeemed
    }

    enum TokenState {
        Inexistent,
        Wrapped,
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
        uint256 lastPrice;
        uint256 endTime;
        uint256 availableFractions;
        uint256 maxBid;
        uint256 bidderId;
        uint256 targetPrice;
    }

    // Fermion F-NFT, buyout auction
    struct AuctionDetails {
        uint256 timer;
        uint256 maxBid;
        address maxBidder;
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
        mapping(uint256 => bool) isFractionalised; // tokenId -> fractionalised
        mapping(uint256 => Auction[]) auctions; // tokenId -> Auction
        uint256 unrestricedRedeemableSupply;
        uint256 unrestricedRedeemableAmount;
        uint256 lockedRedeemableSupply;
        mapping(uint256 => uint256[]) lockedProceeds; // tokenId -> auction index -> amount; locked for users that voted to start
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
