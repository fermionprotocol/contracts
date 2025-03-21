// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IVerificationEvents
 *
 * @notice Defines events related to verification within the protocol.
 */
interface IVerificationEvents {
    event VerificationInitiated(
        uint256 indexed bosonOfferId,
        uint256 indexed verifierId,
        uint256 nftId,
        uint256 itemVerificationTimeout,
        uint256 maxVerificationTimeout
    );
    event ItemVerificationTimeoutChanged(uint256 indexed nftId, uint256 itemVerificationTimeout);
    event VerdictSubmitted(
        uint256 indexed verifierId,
        uint256 indexed nftId,
        FermionTypes.VerificationStatus verificationStatus,
        FermionTypes.Metadata verificationMetadata
    );
    event RevisedMetadataSubmitted(uint256 indexed nftId, string newMetadata);
    event ProposalSubmitted(uint256 indexed nftId, uint16 buyerProposal, uint16 sellerProposal, uint16 lastProposal);
    event PhygitalsVerified(uint256 indexed nftId, address verifier);
}
