// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title ICustodyEvents
 *
 * @notice Defines events related to custody.
 */
interface ICustodyEvents {
    event CheckedIn(uint256 indexed custodianId, uint256 indexed nftId);
    event CheckedOut(uint256 indexed custodianId, uint256 indexed nftId);
    event CheckoutRequested(
        uint256 indexed custodianId,
        uint256 indexed nftId,
        uint256 indexed sellerId,
        address owner
    );
    event TaxAmountSubmitted(uint256 indexed nftId, uint256 indexed sellerId, uint256 taxAmount);
    event CheckOutRequestCleared(uint256 indexed custodianId, uint256 indexed nftId);
}
