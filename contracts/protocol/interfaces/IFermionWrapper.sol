// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

/**
 * @title FermionWrapper interface
 *
 * A set of methods to interact with the FermionWrapper contract.
 */
interface IFermionWrapper is IERC721 {
    /**
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * Reverts if:
     * - Caller does not own the Boson rNFTs
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrap(uint256 _firstTokenId, uint256 _length, address _to) external;

    /**
     * @notice Unwraps the voucher, finalizes the auction, transfers the Boson rNFT to Fermion Protocol and F-NFT to the buyer
     *
     * @param _tokenId The token id.
     * @param _buyerOrder The Seaport buyer order.
     */
    function unwrap(uint256 _tokenId, SeaportTypes.AdvancedOrder calldata _buyerOrder) external;

    /**
     * @notice Unwraps the voucher, but skip the OS auction and leave the F-NFT with the seller
     *
     * @param _tokenId The token id.
     */
    function unwrapToSelf(uint256 _tokenId, address _exchangeToken, uint256 _verifierFee) external;

    /**
     * @notice List fixed order on Seaport
     *
     * @param _firstTokenId The first token id.
     * @param _prices The prices for each token.
     * @param _endTimes The end times for each token.
     * @param _exchangeToken The token to be used for the exchange.
     */
    function listFixedPriceOrders(
        uint256 _firstTokenId,
        uint256[] calldata _prices,
        uint256[] calldata _endTimes,
        address _exchangeToken
    ) external;

    /**
     * @notice Cancel fixed price orders on OpenSea.
     *
     * @param _orders The orders to cancel.
     */
    function cancelFixedPriceOrders(SeaportTypes.OrderComponents[] calldata _orders) external;

    /**
     * @notice Unwraps the voucher, and transfers the sale proceeds to Boson Protocol
     *
     * @param _tokenId The token id.
     * @param _exchangeToken The token to be used for the exchange.
     */
    function unwrapFixedPriced(uint256 _tokenId, address _exchangeToken) external;

    function transferOwnership(address _newOwner) external;
}
