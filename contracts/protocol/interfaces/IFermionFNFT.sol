// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";

/**
 * @title FermionWrapper interface
 *
 * A set of methods to interact with the FermionWrapper contract.
 */
interface IFermionFNFT is IFermionWrapper, IFermionFractions {
    /**
     * @notice Initializes the contract
     *
     * Reverts if:
     * - Contract is already initialized
     *
     * @param _voucherAddress The address of the Boson Voucher contract
     * @param _owner The address of the owner
     * @param _exchangeToken The address of the exchange token
     * @param _offerId The offer id
     * @param _metadataUri The metadata URI, used for all tokens and contract URI
     */
    function initialize(
        address _voucherAddress,
        address _owner,
        address _exchangeToken,
        uint256 _offerId,
        string memory _metadataUri
    ) external;

    /**
     * @notice Burns the token and returns the voucher owner
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     * - Token is not in the Unverified state
     *
     * @param _tokenId The token id.
     */
    function burn(uint256 _tokenId) external returns (address wrappedVoucherOwner);

    /**
     * @notice Pushes the F-NFT from unverified to verified
     *
     * Reverts if:
     * - Caller is not the Fermion Protocol
     * - The new token state is not consecutive to the current state
     *
     * N.B. Not checking if the new state is valid, since the caller is the Fermion Protocol, which is trusted
     *
     * @param _tokenId The token id.
     */
    function pushToNextTokenState(uint256 _tokenId, FermionTypes.TokenState _newState) external;

    function tokenState(uint256 _tokenId) external view returns (FermionTypes.TokenState);

    /**
     * @notice Returns the address of the ERC20 clone for the current epoch
     * Users should interact with this contract directly for ERC20 operations
     *
     * @return The address of the ERC20 clone
     */
    function getERC20FractionsClone() external view returns (address);
}
