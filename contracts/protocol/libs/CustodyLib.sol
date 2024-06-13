// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { ICustodyEvents } from "../interfaces/events/ICustodyEvents.sol";

/**
 * @title EntityLib
 *
 * @notice Custody methods used by multiple facets.
 */
library CustodyLib {
    /**
     * @notice Creates a custodian vault for a tokenId
     * The amount for first period is encumbered (it is available in the protocol since the verification time).
     *
     * @param _tokenId - the token ID
     */
    function setupCustodianItemVault(uint256 _tokenId) internal {
        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_tokenId];

        vault.period = block.timestamp; // period is the time when the vault was created and then reset whenever the funds are released
    }

    /**
     * @notice Closes the custodian vault for a tokenId and releses the amount to the custodian
     *
     * Emits an AvailableFundsIncreased event if successful.
     *
     * @param _tokenId - the token ID
     * @param _custodianId - the custodian ID
     * @param _exchangeToken - the exchange token
     */
    function closeCustodianItemVault(uint256 _tokenId, uint256 _custodianId, address _exchangeToken) internal {
        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_tokenId];

        FundsLib.increaseAvailableFunds(_custodianId, _exchangeToken, vault.amount);

        vault.period = 0;
        vault.amount = 0;

        emit ICustodyEvents.VaultBalanceUpdated(_tokenId, 0);
    }

    /**
     * @notice Adds aditional items to the existing custodian offer vault.
     *
     * Reverts if:
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _firstTokenId - the lowest token ID to add to the vault
     * @param _length - the number of tokens to add to the vault
     * @param pl - the protocol lookups storage
     */
    function addItemToCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionStorage.ProtocolLookups storage pl
    ) internal returns (uint256 offerId, uint256 amountToTransfer) {
        // not testing the checkout request status. After confirming that the called is the FNFT address, we know
        // that fractionalisation can happen only if the item was checked-in
        FermionTypes.Offer storage offer;
        (offerId, offer) = FermionStorage.getOfferFromTokenId(_firstTokenId);
        if (msg.sender != pl.wrapperAddress[offerId]) revert FermionErrors.AccessDenied(msg.sender); // not using msgSender() since the FNFT will never use meta transactions

        uint256 custodianId = offer.custodianId;
        address exchangeToken = offer.exchangeToken;
        FermionTypes.CustodianFee memory custodianFee = offer.custodianFee;
        for (uint256 i = 0; i < _length; i++) {
            // temporary close individual vaults and transfer the amount for unused periods to the offer vault
            uint256 tokenId = _firstTokenId + i;
            FermionTypes.CustodianFee storage itemVault = pl.vault[tokenId];

            // unused period ?
            uint256 balance = itemVault.amount;
            if (balance > 0) {
                uint256 lastReleased = itemVault.period;
                uint256 custodianPayoff = ((block.timestamp - lastReleased) * custodianFee.amount) /
                    custodianFee.period;

                if (custodianPayoff > balance) {
                    // This happens if the F-NFT owner was not paying the custodian fee and the forceful fractionalisation did not happen
                    // The custodian gets everything that's in the vault, but they missed the chance to get the custodian fee via fractionalisation
                    custodianPayoff = balance;
                }
                amountToTransfer += (balance - custodianPayoff);

                itemVault.amount = custodianPayoff;
            }
            closeCustodianItemVault(tokenId, custodianId, exchangeToken);
        }
        pl.custodianVaultItems[offerId] += _length;
    }
}
