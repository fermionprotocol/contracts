// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";

/**
 * @title Fermion Custody facet interface
 *
 * A set of methods to interact with the Fermion custody facet contract.
 */
interface IFermionCustodyVault {
    function setupCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionTypes.CustodianVaultParameters calldata custodianVaultParameters,
        uint256 _depositAmount
    ) external returns (uint256 returnedAmount);

    function addItemToCustodianOfferVault(
        uint256 _tokenId,
        uint256 _amount,
        uint256 _depositAmount
    ) external returns (uint256 returnedAmount);

    function removeItemFromCustodianOfferVault(
        uint256 _tokenId,
        uint256 _buyoutAuctionEnd
    ) external returns (int256 released);
}
