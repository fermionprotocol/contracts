// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";

/**
 * @title Fermion Custody facet interface
 *
 * A set of methods to interact with the Fermion custody facet contract.
 */
interface IFermionCustodyVault {
    function setupCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionTypes.CustodianVaultParameters calldata custodianVaultParameters
    ) external;

    function addItemToCustodianOfferVault(uint256 _tokenId, uint256 _amount) external;

    function removeItemFromCustodianOfferVault(uint256 _tokenId) external returns (uint256 released);
}
