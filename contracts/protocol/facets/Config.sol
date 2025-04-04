// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ADMIN, HUNDRED_PERCENT } from "../domain/Constants.sol";
import { FermionGeneralErrors, VerificationErrors } from "../domain/Errors.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { IConfigEvents } from "../interfaces/events/IConfigEvents.sol";
import { FermionTypes } from "../domain/Types.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/**
 * @title ConfigFacet
 *
 * @notice Handles management of protocol-wide configuration parameters.
 */
contract ConfigFacet is Access, FermionGeneralErrors, IConfigEvents {
    /**
     * @notice Initializes facet.
     * This function is callable only once.
     *
     * @param _config - the protocol configuration parameters
     */
    function init(FermionStorage.ProtocolConfig calldata _config) external {
        // Initialize protocol config params
        setTreasuryAddressInternal(_config.treasury);
        setProtocolFeePercentageInternal(_config.protocolFeePercentage);
        setMaxVerificationTimeoutInternal(_config.maxVerificationTimeout);
        setDefaultVerificationTimeoutInternal(_config.defaultVerificationTimeout);
    }

    /**
     * @notice Sets the Fermion Protocol multi-sig account address.
     *
     * Emits a TreasuryAddressChanged event if successful.
     *
     * Reverts if:
     * - The caller is not a protocol admin
     * - The _treasuryAddress is the zero address
     *
     *
     * @param _treasuryAddress - the multi-sig account address
     */
    function setTreasuryAddress(
        address payable _treasuryAddress
    ) external onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) nonReentrant {
        setTreasuryAddressInternal(_treasuryAddress);
    }

    /**
     * @notice Gets the Fermion Protocol multi-sig account address.
     *
     * @return the Fermion Protocol multi-sig account address
     */
    function getTreasuryAddress() external view returns (address payable) {
        return FermionStorage.protocolConfig().treasury;
    }

    /**
     * @notice Sets the protocol fee percentage.
     *
     * Emits a ProtocolFeePercentageChanged event if successful.
     *
     * Reverts if:
     * - The caller is not a protocol admin
     * - The _protocolFeePercentage is greater than 10000
     *
     * @param _protocolFeePercentage - the percentage that will be taken as a fee from the net of a Boson Protocol sale or auction (after royalties)
     *
     * N.B. Represent percentage value as an unsigned int by multiplying the percentage by 100:
     * e.g, 1.75% = 175, 100% = 10000
     */
    function setProtocolFeePercentage(
        uint16 _protocolFeePercentage
    ) external onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) nonReentrant {
        setProtocolFeePercentageInternal(_protocolFeePercentage);
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
     * @notice Sets the default verification timeout.
     *
     * Emits a DefaultVerificationTimeoutChanged event if successful.
     *
     * Reverts if:
     * - The caller is not a protocol admin
     * - The _defaultVerificationTimeout is 0
     *
     * @dev Caller must have ADMIN role.
     *
     * @param _defaultVerificationTimeout - the period after anyone can reject the verification
     */
    function setDefaultVerificationTimeout(
        uint256 _defaultVerificationTimeout
    ) public onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) {
        setDefaultVerificationTimeoutInternal(_defaultVerificationTimeout);
    }

    /**
     * @notice Gets the current default verification timeout.
     *
     * @return the default verification timeout
     */
    function getDefaultVerificationTimeout() external view returns (uint256) {
        return FermionStorage.protocolConfig().defaultVerificationTimeout;
    }

    /**
     * @notice Sets the max verification timeout.
     *
     * Emits a MaxVerificationTimeoutChanged event if successful.
     *
     * Reverts if:
     * - The caller is not a protocol admin
     * - The _maxVerificationTimeout is 0
     *
     * @dev Caller must have ADMIN role.
     *
     * @param _maxVerificationTimeout - the period after anyone can reject the verification
     */
    function setMaxVerificationTimeout(
        uint256 _maxVerificationTimeout
    ) external onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) nonReentrant {
        setMaxVerificationTimeoutInternal(_maxVerificationTimeout);
    }

    /**
     * @notice Gets the current maximal verification timeout.
     *
     * @return the maximal verification timeout
     */
    function getMaxVerificationTimeout() external view returns (uint256) {
        return FermionStorage.protocolConfig().maxVerificationTimeout;
    }

    /**
     * @notice Sets the Fermion FNFT implmentation address.
     *
     * Emits a FermionFNFTImplementationChanged event if successful.
     *
     * Reverts if:
     * - The caller is not a protocol admin
     * - The _fnftImplementation is the zero address
     *
     * @param _fnftImplementation - the fermion FNFT implementation address
     */
    function setFNFTImplementationAddress(
        address _fnftImplementation
    ) external onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) nonReentrant {
        checkNonZeroAddress(_fnftImplementation);

        UpgradeableBeacon(FermionStorage.protocolStatus().fermionFNFTBeacon).upgradeTo(_fnftImplementation);

        emit FermionFNFTImplementationChanged(_fnftImplementation);
    }

    /**
     * @notice Gets the current Fermion FNFT implementaion address.
     *
     * @return the Fermion FNFT implementation address
     */
    function getFNFTImplementationAddress() external view returns (address) {
        return UpgradeableBeacon(FermionStorage.protocolStatus().fermionFNFTBeacon).implementation();
    }

    /**
     * @notice Sets the max verification timeout.
     *
     * Emits a MaxVerificationTimeoutChanged event if successful.
     *
     * Reverts if the _maxVerificationTimeout is 0.
     *
     * @param _maxVerificationTimeout - the period after anyone can reject the verification
     */
    function setMaxVerificationTimeoutInternal(uint256 _maxVerificationTimeout) internal {
        // Make sure verification timeout is greater than 0
        checkNonZeroValue(_maxVerificationTimeout);

        // Store verification timeout
        FermionStorage.protocolConfig().maxVerificationTimeout = _maxVerificationTimeout;

        // Notify watchers of state change
        emit MaxVerificationTimeoutChanged(_maxVerificationTimeout);
    }

    /**
     * @notice Sets the Boson Protocol multi-sig account address.
     *
     * Emits a TreasuryAddressChanged event if successful.
     *
     * Reverts if _treasuryAddress is the zero address
     *
     * @param _treasuryAddress - the multi-sig account address
     */
    function setTreasuryAddressInternal(address payable _treasuryAddress) internal {
        checkNonZeroAddress(_treasuryAddress);
        FermionStorage.protocolConfig().treasury = _treasuryAddress;
        emit TreasuryAddressChanged(_treasuryAddress);
    }

    /**
     * @notice Sets the protocol fee percentage.
     *
     * Emits a ProtocolFeePercentageChanged event if successful.
     *
     * Reverts if the _protocolFeePercentage is greater than 10000.
     *
     * @param _protocolFeePercentage - the percentage that will be taken as a fee from the net of a Boson Protocol sale or auction (after royalties)
     *
     * N.B. Represent percentage value as an unsigned int by multiplying the percentage by 100:
     * e.g, 1.75% = 175, 100% = 10000
     */
    function setProtocolFeePercentageInternal(uint16 _protocolFeePercentage) internal {
        // Make sure percentage is less than 10000
        checkMaxPercententage(_protocolFeePercentage);

        // Store fee percentage
        FermionStorage.protocolConfig().protocolFeePercentage = _protocolFeePercentage;

        // Notify watchers of state change
        emit ProtocolFeePercentageChanged(_protocolFeePercentage);
    }

    /**
     * @notice Sets the verification timeout.
     *
     * Emits a DefaultVerificationTimeoutChanged event if successful.
     *
     * Reverts if the _defaultVerificationTimeout is 0.
     *
     * @param _defaultVerificationTimeout - the period after anyone can reject the verification
     */
    function setDefaultVerificationTimeoutInternal(uint256 _defaultVerificationTimeout) internal {
        // Make sure that verification timeout greater than 0
        checkNonZeroValue(_defaultVerificationTimeout);

        FermionStorage.ProtocolConfig storage pc = FermionStorage.protocolConfig();
        uint256 maxItemVerificationTimeout = pc.maxVerificationTimeout;
        if (_defaultVerificationTimeout > maxItemVerificationTimeout) {
            revert VerificationErrors.VerificationTimeoutTooLong(
                _defaultVerificationTimeout,
                maxItemVerificationTimeout
            );
        }

        // Store the verification timeout
        pc.defaultVerificationTimeout = _defaultVerificationTimeout;

        // Notify watchers of state change
        emit DefaultVerificationTimeoutChanged(_defaultVerificationTimeout);
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
