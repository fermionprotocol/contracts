// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * @title IFermionConfig
 * @notice Interface for the ConfigFacet
 */
interface IFermionConfig {
    /**
     * @notice Gets the Fermion Protocol multi-sig account address.
     *
     * @return the Fermion Protocol multi-sig account address
     */
    function getTreasuryAddress() external view returns (address payable);

    /**
     * @notice Gets the protocol default fee percentage.
     *
     * @return the protocol fee percentage
     */
    function getProtocolFeePercentage() external view returns (uint256);

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
    function getProtocolFeePercentage(address _exchangeToken, uint256 _price) external view returns (uint16);

    /**
     * @notice Gets the current default verification timeout.
     *
     * @return the default verification timeout
     */
    function getDefaultVerificationTimeout() external view returns (uint256);

    /**
     * @notice Gets the current maximal verification timeout.
     *
     * @return the maximal verification timeout
     */
    function getMaxVerificationTimeout() external view returns (uint256);

    /**
     * @notice Gets the current OpenSea fee percentage.
     *
     * @return the OpenSea fee percentage
     */
    function getOpenSeaFeePercentage() external view returns (uint16);

    /**
     * @notice Gets the current Fermion FNFT implementaion address.
     *
     * @return the Fermion FNFT implementation address
     */
    function getFNFTImplementationAddress() external view returns (address);
}
