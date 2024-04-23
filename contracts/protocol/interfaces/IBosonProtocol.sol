// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title BosonInterface
 *
 * @notice Minimal interface to interact with the Boson Protocol.
 */
interface IBosonProtocol {
    struct Buyer {
        uint256 id;
        address payable wallet;
        bool active;
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

    enum AuthTokenType {
        None,
        Custom,
        Lens,
        ENS
    }

    struct VoucherInitValues {
        string contractURI;
        uint256 royaltyPercentage;
        bytes32 collectionSalt;
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
     * Emits a BuyerCreated event if successful.
     *
     * Reverts if:
     * - The buyers region of protocol is paused
     * - Wallet address is zero address
     * - Active is not true
     * - Wallet address is not unique to this buyer
     *
     * @param _buyer - the fully populated struct with buyer id set to 0x0
     */
    function createBuyer(Buyer memory _buyer) external;

    /**
     * @notice Gets the next account id that can be assigned to an account.
     *
     * @dev Does not increment the counter.
     *
     * @return nextAccountId - the account id
     */
    function getNextAccountId() external view returns (uint256 nextAccountId);
}
