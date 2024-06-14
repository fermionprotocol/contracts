// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title IConfigEvents
 *
 * @notice Defines events related to config.
 */
interface IConfigEvents {
    event TreasuryAddressChanged(address indexed newTreasuryAddress);
    event ProtocolFeePercentageChanged(uint16 newProtocolFeePercentage);
    event VerificationTimeoutChanged(uint256 newVerificationTimeout);
}
