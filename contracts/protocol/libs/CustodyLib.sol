// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionGeneralErrors, CustodianVaultErrors } from "../domain/Errors.sol";
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
    function setupCustodianItemVault(uint256 _tokenId, uint256 _itemVaultSetupTime) internal {
        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().tokenLookups[_tokenId].vault;

        vault.period = _itemVaultSetupTime;
        // period is the time when the vault was created (initial setup), or will be created (after buyout auction)
        // It is reset whenever the funds are released
    }

    /**
     * @notice Closes the custodian vault for a tokenId and releases the amount to the custodian
     *
     * Emits an AvailableFundsIncreased event if successful.
     *
     * @param _tokenId - the token ID
     * @param _custodianId - the custodian ID
     * @param _exchangeToken - the exchange token
     */
    function closeCustodianItemVault(uint256 _tokenId, uint256 _custodianId, address _exchangeToken) internal {
        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().tokenLookups[_tokenId].vault;

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
     * @param _depositAmount - the amount to deposit
     * @param _externalCall - if true, the caller is checked to be the F-NFT contract owning the token. Use false for internal calls.
     * @param pl - the protocol lookups storage
     * @return offerId - the ID of the offer vault
     * @return returnedAmount - the amount returned to the caller
     */
    function addItemToCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _depositAmount,
        bool _externalCall,
        FermionStorage.ProtocolLookups storage pl
    ) internal returns (uint256 offerId, uint256 returnedAmount) {
        // not testing the checkout request status. After confirming that the called is the FNFT address, we know
        // that fractionalisation can happen only if the item was checked-in
        returnedAmount = _depositAmount;
        uint256 custodianId;
        address exchangeToken;
        FermionTypes.CustodianFee memory custodianFee;
        FermionStorage.OfferLookups storage offerLookups;
        {
            FermionTypes.Offer storage offer;
            (offerId, offer) = FermionStorage.getOfferFromTokenId(_firstTokenId);
            offerLookups = pl.offerLookups[offerId];
            if (_externalCall && msg.sender != offerLookups.fermionFNFTAddress)
                revert FermionGeneralErrors.AccessDenied(msg.sender); // not using msgSender() since the FNFT will never use meta transactions

            custodianId = offer.custodianId;
            exchangeToken = offer.exchangeToken;
            custodianFee = offer.custodianFee;
        }
        uint256 amountToTransferToOfferVault;

        for (uint256 i = 0; i < _length; i++) {
            // temporary close individual vaults and transfer the amount for unused periods to the offer vault
            uint256 tokenId = _firstTokenId + i;
            FermionTypes.CustodianFee storage itemVault = pl.tokenLookups[tokenId].vault;

            // when fractionalisation happens, the owner must pay for used period + 1 future period to prevent fee evasion
            uint256 balance = itemVault.amount;
            uint256 lastReleased = itemVault.period;
            uint256 custodianPayoff = ((block.timestamp - lastReleased) * custodianFee.amount) / custodianFee.period;

            if (custodianPayoff + custodianFee.amount > balance) {
                // In case of external fractionalisation, the caller can provide additional funds to cover the custodian fee. If not enough, revert.
                if (_externalCall) {
                    // Full custodian payoff must be paid in order to fractionalise
                    uint256 diff = custodianPayoff + custodianFee.amount - balance;
                    if (returnedAmount > diff) {
                        returnedAmount -= diff;
                        balance = custodianPayoff + custodianFee.amount;
                    } else {
                        revert CustodianVaultErrors.InsufficientBalanceToFractionalise(tokenId, diff);
                    }
                } else {
                    // If forceful fractionalisation, transfer the max amount available to the custodian
                    custodianPayoff = balance;
                }
            }
            amountToTransferToOfferVault += (balance - custodianPayoff); // transfer the amount for unused periods to the offer vault
            itemVault.amount = custodianPayoff;
            closeCustodianItemVault(tokenId, custodianId, exchangeToken);
        }
        offerLookups.custodianVaultItems += _length;

        FermionTypes.CustodianFee storage offerVault = pl.tokenLookups[offerId].vault;
        if (offerVault.period == 0) offerVault.period = block.timestamp;
        offerVault.amount += amountToTransferToOfferVault;

        if (_externalCall && returnedAmount > 0) {
            FundsLib.transferFundsFromProtocol(exchangeToken, payable(msg.sender), returnedAmount); // not using msgSender() since caller is FermionFNFT contract
        }
        emit ICustodyEvents.VaultBalanceUpdated(offerId, offerVault.amount);
    }
}
