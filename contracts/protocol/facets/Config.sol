// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ADMIN, HUNDRED_PERCENT } from "../domain/Constants.sol";
import { FermionGeneralErrors, VerificationErrors } from "../domain/Errors.sol";
import { Access } from "../bases/mixins/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { FeeLib } from "../libs/FeeLib.sol";
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
     * @param _treasury The address of the protocol treasury where protocol fees will be sent.
     * @param _protocolFeePercentage The default fee percentage that the protocol will charge (in basis points).
     * @param _maxVerificationTimeout The maximum allowed verification timeout in seconds.
     * @param _defaultVerificationTimeout The default timeout in seconds for verification if none is specified.
     * @param _openSeaFeePercentage The OpenSea fee percentage (in basis points, e.g. 2.5% = 250).
     */
    function init(
        address payable _treasury,
        uint16 _protocolFeePercentage,
        uint256 _maxVerificationTimeout,
        uint256 _defaultVerificationTimeout,
        uint16 _openSeaFeePercentage
    ) external {
        // Initialize protocol config params
        setTreasuryAddressInternal(_treasury);
        setProtocolFeePercentageInternal(_protocolFeePercentage);
        setMaxVerificationTimeoutInternal(_maxVerificationTimeout);
        setDefaultVerificationTimeoutInternal(_defaultVerificationTimeout);
        setOpenSeaFeePercentageInternal(_openSeaFeePercentage);
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
     * @notice Sets the feeTable for a specific token given price ranges and fee tiers for
     * the corresponding price ranges.
     *
     * Reverts if the number of fee percentages does not match the number of price ranges.
     * Reverts if the price ranges are not in ascending order.
     * Reverts if any of the fee percentages value is above 100%.
     *
     * @dev Caller must have ADMIN role.
     *
     * @param _tokenAddress - the address of the token
     * @param _priceRanges - array of token price ranges
     * @param _feePercentages - array of fee percentages corresponding to each price range
     */
    function setProtocolFeeTable(
        address _tokenAddress,
        uint256[] calldata _priceRanges,
        uint16[] calldata _feePercentages
    ) external onlyRole(ADMIN) nonReentrant {
        if (_priceRanges.length != _feePercentages.length)
            revert ArrayLengthMismatch(_priceRanges.length, _feePercentages.length);
        // Clear existing price ranges and percentage tiers
        FermionStorage.ProtocolConfig storage protocolConfig = FermionStorage.protocolConfig();
        delete protocolConfig.tokenPriceRanges[_tokenAddress];
        delete protocolConfig.tokenFeePercentages[_tokenAddress];

        // Store fee percentage
        if (_priceRanges.length != 0) {
            setTokenPriceRangesInternal(_tokenAddress, _priceRanges);
            setTokenFeePercentagesInternal(_tokenAddress, _feePercentages);
        }
        emit FeeTableUpdated(_tokenAddress, _priceRanges, _feePercentages);
    }

    /**
     * @notice Gets the current fee table for a given token.
     *
     * @dev This funciton is used to check price ranges config. If you need to apply percentage based on
     *      _exchangeToken and offerPrice, use getProtocolFeePercentage(address,uint256)
     *
     * @param _tokenAddress - the address of the token
     * @return priceRanges - array of token price ranges
     * @return feePercentages - array of fee percentages corresponding to each price range
     */
    function getProtocolFeeTable(
        address _tokenAddress
    ) external view returns (uint256[] memory priceRanges, uint16[] memory feePercentages) {
        FermionStorage.ProtocolConfig storage protocolConfig = FermionStorage.protocolConfig();
        priceRanges = protocolConfig.tokenPriceRanges[_tokenAddress];
        feePercentages = protocolConfig.tokenFeePercentages[_tokenAddress];
    }

    /**
     * @notice Gets the protocol default fee percentage.
     *
     * @return the protocol fee percentage
     */
    function getProtocolFeePercentage() external view returns (uint256) {
        return FermionStorage.protocolConfig().protocolFeePercentage;
    }

    /**
     * @notice Gets the protocol fee percentage based on protocol fee table
     *
     * @dev This function calculates the protocol fee percentage for specific token and price.
     * If the token has a custom fee table configured, it returns the corresponding fee percentage
     * for the price range. If the token does not have a custom fee table, it falls back
     * to the default protocol fee percentage.
     *
     *
     * @param _exchangeToken - The address of the token being used for the exchange.
     * @param _price - The price of the item or service in the exchange.
     *
     * @return the protocol fee percentage for given price and exchange token
     */
    function getProtocolFeePercentage(address _exchangeToken, uint256 _price) external view returns (uint16) {
        return FeeLib.getProtocolFeePercentage(_exchangeToken, _price);
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
     * @notice Sets the OpenSea fee percentage.
     *
     * Emits an OpenSeaFeePercentageChanged event if successful.
     *
     * Reverts if:
     * - The caller is not a protocol admin
     * - The _openSeaFeePercentage value is greater than 10000
     *
     * @param _openSeaFeePercentage - the percentage that OpenSea takes as a fee in basis points (e.g, 2.5% = 250, 100% = 10000)
     *
     */
    function setOpenSeaFeePercentage(
        uint16 _openSeaFeePercentage
    ) external onlyRole(ADMIN) notPaused(FermionTypes.PausableRegion.Config) nonReentrant {
        setOpenSeaFeePercentageInternal(_openSeaFeePercentage);
    }

    /**
     * @notice Gets the current OpenSea fee percentage.
     *
     * @return the OpenSea fee percentage
     */
    function getOpenSeaFeePercentage() external view returns (uint16) {
        return FermionStorage.protocolConfig().openSeaFeePercentage;
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
     * @notice Sets the price ranges for a specific token.
     *
     * Reverts if priceRanges are not in ascending order.
     *
     * @param _tokenAddress - the address of the token
     * @param _priceRanges - array of price ranges for the token
     */
    function setTokenPriceRangesInternal(address _tokenAddress, uint256[] calldata _priceRanges) internal {
        for (uint256 i = 1; i < _priceRanges.length; ++i) {
            if (_priceRanges[i] <= _priceRanges[i - 1]) revert NonAscendingOrder();
        }
        FermionStorage.protocolConfig().tokenPriceRanges[_tokenAddress] = _priceRanges;
    }

    /**
     * @notice Sets the fee percentages for a specific token and price ranges.
     *
     * @param _tokenAddress - the address of the token
     * @param _feePercentages - array of fee percentages corresponding to each price range
     */
    function setTokenFeePercentagesInternal(address _tokenAddress, uint16[] calldata _feePercentages) internal {
        // Set the fee percentages for the token
        for (uint256 i; i < _feePercentages.length; ++i) {
            checkMaxPercententage(_feePercentages[i]);
        }
        FermionStorage.protocolConfig().tokenFeePercentages[_tokenAddress] = _feePercentages;
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
     * @notice Sets the OpenSea fee percentage.
     *
     * Emits an OpenSeaFeePercentageChanged event if successful.
     *
     * Reverts if:
     * - The caller is not a protocol admin
     * - The _openSeaFeePercentage value is greater than 10000
     *
     * @param _openSeaFeePercentage - the percentage that OpenSea takes as a fee in basis points (e.g, 2.5% = 250, 100% = 10000)
     *
     */
    function setOpenSeaFeePercentageInternal(uint16 _openSeaFeePercentage) internal {
        checkMaxPercententage(_openSeaFeePercentage);
        FermionStorage.protocolConfig().openSeaFeePercentage = _openSeaFeePercentage;
        emit OpenSeaFeePercentageChanged(_openSeaFeePercentage);
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
