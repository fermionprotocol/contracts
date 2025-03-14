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
        Rejected,
        Pending
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

    enum PriceUpdateProposalState {
        NotInit, // Explicitly represents an uninitialized state
        Active,
        Executed,
        Failed
    }

    enum WrapType {
        SELF_SALE,
        OS_AUCTION,
        OS_FIXED_PRICE
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

    struct Metadata {
        string URI;
        string hash;
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
        bool withPhygital;
        Metadata metadata;
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

    struct CustodianUpdateRequest {
        uint256 newCustodianId;
        CustodianFee custodianFee;
        CustodianVaultParameters custodianVaultParameters;
        uint256 requestTimestamp;
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
        address priceOracle;
        PriceUpdateProposal currentProposal; // Stores the single active proposal
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

    struct PriceUpdateProposal {
        uint256 proposalId; // Tracks the ID of the current proposal
        uint256 newExitPrice;
        uint256 votingDeadline;
        uint256 quorumPercent; // in bps (e.g. 2000 is 20%)
        uint256 yesVotes;
        uint256 noVotes;
        PriceUpdateProposalState state;
        mapping(address => PriceUpdateVoter) voters;
    }

    struct PriceUpdateVoter {
        uint256 proposalId; // Tracks the ID of the proposal the voter last voted on
        bool votedYes;
        uint256 voteCount;
    }

    struct Auction {
        AuctionDetails details;
        Votes votes;
    }

    struct SplitProposal {
        uint16 buyer;
        uint16 seller;
        bool matching;
    }

    struct Phygital {
        address contractAddress;
        uint256 tokenId;
    }
}
