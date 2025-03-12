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
    event MaxRoyaltyPercentageChanged(uint16 newMaxRoyaltyPercentage);
    event DefaultVerificationTimeoutChanged(uint256 newVerificationTimeout);
    event MaxVerificationTimeoutChanged(uint256 newMaxVerificationTimeout);
    event FermionFNFTImplementationChanged(address newFermionFNFTImplementation);
    event FeeTableUpdated(address indexed token, uint256[] priceRanges, uint16[] feePercentages);
}
