// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

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

    event AuctionStarted(uint256 indexed tokenId, uint256 offeredFractions, uint256 auctionEnd);
    event BidPlaced(uint256 indexed tokenId, address indexed bidder, uint256 bidderId, uint256 amount);
    event AuctionFinished(uint256 indexed tokenId, address indexed winner, uint256 soldFractions, uint256 winningBid);
    event VaultBalanceUpdated(uint256 indexed tokenId, uint256 amount);
    event CustodianUpdateRequested(
        uint256 indexed offerId,
        uint256 indexed currentCustodianId,
        uint256 indexed newCustodianId,
        FermionTypes.CustodianFee newCustodianFee,
        FermionTypes.CustodianVaultParameters newCustodianVaultParameters
    );
    event CustodianUpdateAccepted(
        uint256 indexed offerId,
        uint256 indexed oldCustodianId,
        uint256 indexed newCustodianId,
        FermionTypes.CustodianFee newCustodianFee,
        FermionTypes.CustodianVaultParameters newCustodianVaultParameters
    );
    event CustodianUpdateRejected(uint256 indexed offerId, uint256 indexed newCustodianId);
}
