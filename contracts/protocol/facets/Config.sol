// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ADMIN, HUNDRED_PERCENT } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { IConfigEvents } from "../interfaces/events/IConfigEvents.sol";
import { FermionTypes } from "../domain/Types.sol";

/**
 * @title ConfigFacet
 *
 * @notice Handles management of protocol-wide configuration parameters.
 */
contract ConfigFacet is Access, FermionErrors, IConfigEvents {
    /**
     * @notice Initializes facet.
     * This function is callable only once.
     *
     * @param _config - the protocol configuration parameters
     */
    function init(FermionStorage.ProtocolConfig calldata _config) public {
        // Initialize protocol config params
        setTreasuryAddress(_config.treasury);
        setProtocolFeePercentage(_config.protocolFeePercentage);
        setVerificationTimeout(_config.verificationTimeout);
    }

    /**
     * @notice Sets the Boson Protocol multi-sig wallet address.
     *
     * Emits a TreasuryAddressChanged event if successful.
     *
     * Reverts if _treasuryAddress is the zero address
     *
     * @dev Caller must have ADMIN role.
     *
     * @param _treasuryAddress - the the multi-sig wallet address
     */
    function setTreasuryAddress(
        address payable _treasuryAddress
    ) public onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) {
        checkNonZeroAddress(_treasuryAddress);
        FermionStorage.protocolConfig().treasury = _treasuryAddress;
        emit TreasuryAddressChanged(_treasuryAddress);
    }

    /**
     * @notice Gets the Boson Protocol multi-sig wallet address.
     *
     * @return the Boson Protocol multi-sig wallet address
     */
    function getTreasuryAddress() external view returns (address payable) {
        return FermionStorage.protocolConfig().treasury;
    }

    /**
     * @notice Sets the protocol fee percentage.
     *
     * Emits a ProtocolFeePercentageChanged event if successful.
     *
     * Reverts if the _protocolFeePercentage is greater than 10000.
     *
     * @dev Caller must have ADMIN role.
     *
     * @param _protocolFeePercentage - the percentage that will be taken as a fee from the net of a Boson Protocol sale or auction (after royalties)
     *
     * N.B. Represent percentage value as an unsigned int by multiplying the percentage by 100:
     * e.g, 1.75% = 175, 100% = 10000
     */
    function setProtocolFeePercentage(
        uint16 _protocolFeePercentage
    ) public onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) {
        // Make sure percentage is less than 10000
        checkMaxPercententage(_protocolFeePercentage);

        // Store fee percentage
        FermionStorage.protocolConfig().protocolFeePercentage = _protocolFeePercentage;

        // Notify watchers of state change
        emit ProtocolFeePercentageChanged(_protocolFeePercentage);
    }

    /**
     * @notice Gets the protocol fee percentage.
     *
     * @return the protocol fee percentage
     */
    function getProtocolFeePercentage() external view returns (uint256) {
        return FermionStorage.protocolConfig().protocolFeePercentage;
    }

    /**
     * @notice Sets the verification timeout.
     *
     * Emits a VerificationTimeoutChanged event if successful.
     *
     * Reverts if the _protocolFeePercentage is 0.
     *
     * @dev Caller must have ADMIN role.
     *
     * @param _verificationTimeout - the period after anyone can reject the verification
     */
    function setVerificationTimeout(
        uint256 _verificationTimeout
    ) public onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) {
        // Make sure percentage is less than 10000
        checkNonZeroValue(_verificationTimeout);

        // Store fee percentage
        FermionStorage.protocolConfig().verificationTimeout = _verificationTimeout;

        // Notify watchers of state change
        emit VerificationTimeoutChanged(_verificationTimeout);
    }

    /**
     * @notice Gets the current verification timeout.
     *
     * @return the verification timeout
     */
    function getVerificationTimeout() external view returns (uint256) {
        return FermionStorage.protocolConfig().verificationTimeout;
    }

    /**
     * @notice Checks that supplied value is not 0.
     *
     * Reverts if the value is zero
     */
    function checkNonZeroValue(uint256 _value) internal pure {
        if (_value == 0) revert ZeroNotAllowed();
    }

    /**
     * @notice Checks that supplied value is not address 0.
     *
     * Reverts if the value is address zero
     */
    function checkNonZeroAddress(address _address) internal pure {
        if (_address == address(0)) revert InvalidAddress();
    }

    /**
     * @notice Checks that supplied value is less or equal to 10000 (100%).
     *
     * Reverts if the value more than 10000
     */
    function checkMaxPercententage(uint16 _percentage) internal pure {
        if (_percentage > HUNDRED_PERCENT) revert InvalidPercentage(_percentage);
    }
}
