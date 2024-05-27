// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IVerificationEvents
 *
 * @notice Defines events related to verification within the protocol.
 */
interface IVerificationEvents {
    event VerificationInitiated(uint256 indexed bosonOfferId, uint256 indexed verifierId, uint256 nftId);

    event VerdictSubmitted(
        uint256 indexed verifierId,
        uint256 indexed nftId,
        FermionTypes.VerificationStatus verificationStatus
    );
}
