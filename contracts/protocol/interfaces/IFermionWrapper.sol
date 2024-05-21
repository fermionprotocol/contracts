// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title FermionWrapper interface
 *
 * A set of methods to interact with the FermionWrapper contract.
 */
interface IFermionWrapper is IERC721 {
    error AlreadyInitialized();

    /**
     * @notice Initializes the contract
     *
     * Reverts if:
     * - Contract is already initialized
     *
     * @param _voucherAddress The address of the Boson Voucher contract
     * @param _owner The address of the owner
     */
    function initialize(address _voucherAddress, address _owner) external;
    /**
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * Reverts if:
     * - Caller does not own the Boson rNFTs
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrapForAuction(uint256 _firstTokenId, uint256 _length, address _to) external;
}
