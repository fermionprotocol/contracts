// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title FermionBuyout interface
 *
 * A set of methods to interact with the FermionBuyout contract.
 */
interface IFermionBuyoutAuction {
    /**
     * @notice Starts the auction for a specific fractionalized token. Can be called by anyone.
     *
     * Emits:
     * - `AuctionStarted` event indicating the start of the auction.
     *
     * Reverts:
     * - `TokenNotFractionalised` if the specified token has not been fractionalized.
     * - `AuctionOngoing` if the auction is already ongoing or has transitioned to a state other than `NotStarted`.
     * - `BidBelowExitPrice` if the highest bid is below the required exit price set for the auction.
     *
     * @param _tokenId The ID of the fractionalized token for which the auction is being started.
     */
    function startAuction(uint256 _tokenId) external;
}
