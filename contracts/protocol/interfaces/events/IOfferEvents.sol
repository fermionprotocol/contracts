// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IOfferEvents
 *
 * @notice Defines events related to offer management within the protocol.
 */
interface IOfferEvents {
    event OfferCreated(
        uint256 indexed sellerId,
        uint256 indexed verifierId,
        uint256 indexed custodianId,
        FermionTypes.Offer offer,
        uint256 bosonOfferId
    );
    event NFTsMinted(uint256 indexed bosonOfferId, uint256 startingNFTId, uint256 quantity);
}
