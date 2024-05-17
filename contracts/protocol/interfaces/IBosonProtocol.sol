// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title BosonInterface
 *
 * @notice Minimal interface to interact with the Boson Protocol.
 * Interface methods are copied here instead of being imported from bosonprotocol because of pragma incompatibility.
 */
interface IBosonProtocol {
    enum AuthTokenType {
        None,
        Custom,
        Lens,
        ENS
    }

    enum PriceType {
        Static, // Default should always be at index 0. Never change this value.
        Discovery
    }

    struct Seller {
        uint256 id;
        address assistant;
        address admin;
        address clerk; // Deprecated. Kept for backwards compatibility.
        address payable treasury;
        bool active;
        string metadataUri;
    }

    struct AuthToken {
        uint256 tokenId;
        AuthTokenType tokenType;
    }

    struct VoucherInitValues {
        string contractURI;
        uint256 royaltyPercentage;
        bytes32 collectionSalt;
    }

    struct Buyer {
        uint256 id;
        address payable wallet;
        bool active;
    }

    struct DisputeResolver {
        uint256 id;
        uint256 escalationResponsePeriod;
        address assistant;
        address admin;
        address clerk; // Deprecated. Kept for backwards compatibility.
        address payable treasury;
        string metadataUri;
        bool active;
    }

    struct DisputeResolverFee {
        address tokenAddress;
        string tokenName;
        uint256 feeAmount;
    }

    struct Offer {
        uint256 id;
        uint256 sellerId;
        uint256 price;
        uint256 sellerDeposit;
        uint256 buyerCancelPenalty;
        uint256 quantityAvailable;
        address exchangeToken;
        PriceType priceType;
        string metadataUri;
        string metadataHash;
        bool voided;
        uint256 collectionIndex;
        RoyaltyInfo[] royaltyInfo;
    }

    struct OfferDates {
        uint256 validFrom;
        uint256 validUntil;
        uint256 voucherRedeemableFrom;
        uint256 voucherRedeemableUntil;
    }

    struct OfferDurations {
        uint256 disputePeriod;
        uint256 voucherValid;
        uint256 resolutionPeriod;
    }

    struct RoyaltyInfo {
        address payable[] recipients;
        uint256[] bps;
    }

    /**
     * @notice Creates a seller.
     *
     * @param _seller - the fully populated struct with seller id set to 0x0
     * @param _authToken - optional AuthToken struct that specifies an AuthToken type and tokenId that the seller can use to do admin functions
     * @param _voucherInitValues - the fully populated BosonTypes.VoucherInitValues struct
     */
    function createSeller(
        Seller memory _seller,
        AuthToken calldata _authToken,
        VoucherInitValues calldata _voucherInitValues
    ) external;

    /**
     * @notice Creates a buyer.
     *
     * @param _buyer - the fully populated struct with buyer id set to 0x0
     */
    function createBuyer(Buyer memory _buyer) external;

    /**
     * @notice Creates a dispute resolver.
     *
     * @param _disputeResolver - the fully populated struct with dispute resolver id set to 0x0
     * @param _disputeResolverFees - list of fees dispute resolver charges per token type. Zero address is native currency. See {BosonTypes.DisputeResolverFee}
     *                               feeAmount will be ignored because protocol doesn't yet support fees yet but DR still needs to provide array of fees to choose supported tokens
     * @param _sellerAllowList - list of ids of sellers that can choose this dispute resolver. If empty, there are no restrictions on which seller can choose it.
     */
    function createDisputeResolver(
        DisputeResolver memory _disputeResolver,
        DisputeResolverFee[] calldata _disputeResolverFees,
        uint256[] calldata _sellerAllowList
    ) external;

    /**
     * @notice Gets the next account id that can be assigned to an account.
     *
     * @dev Does not increment the counter.
     *
     * @return nextAccountId - the account id
     */
    function getNextAccountId() external view returns (uint256 nextAccountId);

    /**
     * @notice Creates an offer.
     *
     *
     * @param _offer - the fully populated struct with offer id set to 0x0 and voided set to false
     * @param _offerDates - the fully populated offer dates struct
     * @param _offerDurations - the fully populated offer durations struct
     * @param _disputeResolverId - the id of chosen dispute resolver (can be 0)
     * @param _agentId - the id of agent
     * @param _feeLimit - the maximum fee that seller is willing to pay per exchange (for static offers)
     */
    function createOffer(
        Offer memory _offer,
        OfferDates calldata _offerDates,
        OfferDurations calldata _offerDurations,
        uint256 _disputeResolverId,
        uint256 _agentId,
        uint256 _feeLimit
    ) external;

    /**
     * @notice Adds DisputeResolverFees to an existing dispute resolver.
     *
     * @param _disputeResolverId - id of the dispute resolver
     * @param _disputeResolverFees - list of fees dispute resolver charges per token type. Zero address is native currency. See {BosonTypes.DisputeResolverFee}
     *                               feeAmount will be ignored because protocol doesn't yet support fees yet but DR still needs to provide array of fees to choose supported tokens
     */
    function addFeesToDisputeResolver(
        uint256 _disputeResolverId,
        DisputeResolverFee[] calldata _disputeResolverFees
    ) external;

    /**
     * @notice Gets the next offer id.
     *
     * @dev Does not increment the counter.
     *
     * @return nextOfferId - the next offer id
     */
    function getNextOfferId() external view returns (uint256 nextOfferId);
}
