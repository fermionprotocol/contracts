// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { HUNDRED_PERCENT, AUCTION_END_BUFFER, MINIMAL_BID_INCREMENT, DEFAULT_FRACTION_AMOUNT, PARTIAL_THRESHOLD_MULTIPLIER, LIQUIDATION_THRESHOLD_MULTIPLIER, PARTIAL_AUCTION_DURATION_DIVISOR } from "../domain/Constants.sol";
import { FundsErrors, FermionGeneralErrors, CustodianVaultErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Access } from "../bases/mixins/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Custody } from "../bases/mixins/Custody.sol";
import { FundsManager } from "../bases/mixins/FundsManager.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { Context } from "../bases/mixins/Context.sol";
import { ICustodyEvents } from "../interfaces/events/ICustodyEvents.sol";
import { FermionFNFTLib } from "../libs/FermionFNFTLib.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CustodyVaultFacet
 *
 * @notice Handles Custody Vaults and partial auctions.
 */
contract CustodyVaultFacet is Context, CustodianVaultErrors, Access, Custody, ICustodyEvents {
    using FermionFNFTLib for address;
    using SafeERC20 for IERC20;
    constructor(bytes32 _fnftCodeHash) FundsManager(_fnftCodeHash) {}

    /**
     * @notice When the first NFT is fractionalised, the custodian offer vault is setup.
     * The items' vaults are temporarily closed. If their balance was not zero, the custodian fee, proportional to the passed service time,
     * is released to the custodian and the remaining amount is transferred to the offer vault.
     *
     * Only the F-NFT contract can call this function. The F-NFT contract is trusted to call this function only when the initial fractionalisation happens.
     *
     * Emits an VaultBalanceUpdated events
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _firstTokenId - the lowest token ID to add to the vault
     * @param _length - the number of tokens to add to the vault
     * @param _custodianVaultParameters - the custodian vault parameters
     * @param _depositAmount - the amount to deposit
     * @return returnedAmount - the amount returned to the caller
     */
    function setupCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionTypes.CustodianVaultParameters memory _custodianVaultParameters,
        uint256 _depositAmount
    ) external notPaused(FermionTypes.PausableRegion.CustodyVault) nonReentrant returns (uint256 returnedAmount) {
        returnedAmount = setupCustodianOfferVault(
            _firstTokenId,
            _length,
            _custodianVaultParameters,
            _depositAmount,
            true
        );
    }

    /**
     * @notice Adds aditional items to the existing custodian offer vault.
     *
     * Only the F-NFT contract can call this function. The F-NFT contract is trusted to call this function only when additional fractionalisations happen.
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _firstTokenId - the lowest token ID to add to the vault
     * @param _length - the number of tokens to add to the vault
     * @param _depositAmount - the amount to deposit
     * @return returnedAmount - the amount returned to the caller
     */
    function addItemToCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _depositAmount
    ) external notPaused(FermionTypes.PausableRegion.CustodyVault) nonReentrant returns (uint256 returnedAmount) {
        (, returnedAmount) = addItemToCustodianOfferVault(
            _firstTokenId,
            _length,
            _depositAmount,
            true,
            FermionStorage.protocolLookups()
        );
    }

    /**
     * @notice Removes the item from the custodian offer vault. This happens when a buyout auction is finalized.
     * The custodian fee, proportional to the passed service time, is released to the custodian and the remaining amount is transferred to the
     * Fermion F-NFT contract where it's added to auction proceeds.
     *
     * Only the F-NFT contract can call this function. The F-NFT contract is trusted to call this function only when buyout auction is finalized.
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _tokenId - the token id to remove from the vault
     * @param _buyoutAuctionEnd - the timestamp when the buyout auction will end
     * @return released - the amount released to the the FNFT auction. If positive, the fraction owner gets it. If negative, the custodian gets it.
     */
    function removeItemFromCustodianOfferVault(
        uint256 _tokenId,
        uint256 _buyoutAuctionEnd
    ) external notPaused(FermionTypes.PausableRegion.CustodyVault) returns (int256 released) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        // Only F-NFT contract can call it
        uint256 offerId;
        FermionTypes.Offer storage offer;
        (offerId, offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        verifyFermionFNFTCaller(offerId, pl);

        // trust the F-NFT contract that the token was added to offer vault at some point, i.e. it was fractionalised
        FermionTypes.CustodianFee storage offerVault = pl.tokenLookups[offerId].vault;

        {
            FermionTypes.CustodianFee storage custodianFee = offer.custodianFee;
            FermionStorage.OfferLookups storage offerLookups = pl.offerLookups[offerId];
            uint256 itemCount = offerLookups.custodianVaultItems;
            uint256 itemBalance = offerVault.amount / itemCount;

            uint256 custodianPayoff = ((_buyoutAuctionEnd - offerVault.period) * custodianFee.amount) /
                custodianFee.period;
            released = int256(itemBalance) - int256(custodianPayoff); // can be negative. When the buyout auction ends this is paid out first.
            if (custodianPayoff > itemBalance) {
                // This happens if the vault balance fell below auction threshold and the forceful fractionalisation did not happen
                // The custodian gets everything that's in the vault, they might get the remaining amount after the buyout auction ends
                custodianPayoff = itemBalance;
            }

            unchecked {
                offerVault.amount -= itemBalance;
            }

            offerLookups.custodianVaultItems--;

            {
                address exchangeToken = offer.exchangeToken;
                increaseAvailableFunds(offer.custodianId, exchangeToken, custodianPayoff);
                uint256 immediateTransfer = itemBalance - custodianPayoff;
                if (immediateTransfer > 0)
                    transferERC20FromProtocol(exchangeToken, payable(msg.sender), immediateTransfer);
            }

            if (itemCount == 1) {
                // closing the offer vault
                offerVault.period = 0;
            }
        }

        // setup back the individual custodian vault
        setupCustodianItemVault(_tokenId, _buyoutAuctionEnd);

        emit VaultBalanceUpdated(offerId, offerVault.amount);
    }

    /** Repays the debt after the buyout auction ends. The custodian gets the remaining amount from the vault.
     * It is possible that the buyout auction did not cover all outstanding debt.
     *
     * Only the F-NFT contract can call it.
     *
     * Reverts if:
     * - Custody region is paused
     * - Caller is not the F-NFT contract owning the token
     */
    function repayDebt(
        uint256 _tokenId,
        uint256 _repaidAmount
    ) external notPaused(FermionTypes.PausableRegion.CustodyVault) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        // Only F-NFT contract can call it
        uint256 offerId;
        FermionTypes.Offer storage offer;
        (offerId, offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        verifyFermionFNFTCaller(offerId, pl);

        increaseAvailableFunds(offer.custodianId, offer.exchangeToken, _repaidAmount);
    }

    /**
     * @notice Receives funds from the caller, and tops up the custodian vault.
     *
     * Emits VaultBalanceUpdated event if successful.
     *
     * Reverts if:
     * - Custody region is paused
     * - Amount to deposit is zero
     * - Vault is not active
     * - Exchange token is native token and caller does not send enough
     * - Exchange token is some ERC20 token and caller also sends native currency
     * - Contract at token address does not support ERC20 function transferFrom
     * - Calling transferFrom on token fails for some reason (e.g. protocol is not approved to transfer)
     * - Received token amount differs from the expected value
     *
     * @param _tokenOrOfferId - token ID associated with the vault
     * @param _amount - amount to be credited
     */
    function topUpCustodianVault(
        uint256 _tokenOrOfferId,
        uint256 _amount
    ) external payable notPaused(FermionTypes.PausableRegion.CustodyVault) nonReentrant {
        if (_amount == 0) revert FundsErrors.ZeroDepositNotAllowed();

        FermionTypes.Offer storage offer;
        bool isOfferVault = _tokenOrOfferId < (1 << 128);
        if (isOfferVault) {
            offer = FermionStorage.protocolEntities().offer[_tokenOrOfferId];
        } else {
            (, offer) = FermionStorage.getOfferFromTokenId(_tokenOrOfferId);
        }
        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().tokenLookups[_tokenOrOfferId].vault;

        if (vault.period == 0) revert InactiveVault(_tokenOrOfferId);

        validateIncomingPayment(offer.exchangeToken, _amount);

        vault.amount += _amount;

        emit VaultBalanceUpdated(_tokenOrOfferId, vault.amount);
    }

    /**
     * @notice Releases the funds from the vault to the custodian.
     * Custodian must call withdrawFunds to get the funds.
     * If the vault amount falls below the custodian fee for a single period, a fractional auction is started.
     *
     * Emits VaultBalanceUpdated and AvailableFundsIncreased events if successful.
     *
     * Reverts if:
     * - Custody region is paused
     * - Vault is not active
     * - Payment period is not over
     *
     * @param _tokenOrOfferId - token ID associated with the vault
     */
    function releaseFundsFromVault(
        uint256 _tokenOrOfferId
    )
        public
        notPaused(FermionTypes.PausableRegion.CustodyVault)
        nonReentrant
        returns (uint256 amountToRelease, address exchangeToken)
    {
        uint256 tokenOrOfferId = _tokenOrOfferId; // to avoid stack too deep error
        bool isOfferVault = tokenOrOfferId < (1 << 128);
        FermionTypes.Offer storage offer;
        uint256 offerId;
        uint256 numberOfPeriods;
        FermionTypes.CustodianFee storage vault;
        FermionTypes.CustodianFee memory custodianFee;
        uint256 coveredPeriods;
        FermionStorage.OfferLookups storage offerLookups;

        {
            FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
            uint256 itemCount;
            if (isOfferVault) {
                offer = FermionStorage.protocolEntities().offer[tokenOrOfferId];
                offerId = tokenOrOfferId;
                offerLookups = pl.offerLookups[offerId];
                itemCount = offerLookups.custodianVaultItems;
            } else {
                (offerId, offer) = FermionStorage.getOfferFromTokenId(tokenOrOfferId);
                offerLookups = pl.offerLookups[offerId];
                itemCount = 1;
            }

            vault = pl.tokenLookups[tokenOrOfferId].vault;
            custodianFee = offer.custodianFee;

            {
                uint256 lastReleased = vault.period;
                if (lastReleased == 0) revert InactiveVault(tokenOrOfferId);

                if (block.timestamp < lastReleased + custodianFee.period)
                    revert PeriodNotOver(tokenOrOfferId, lastReleased + custodianFee.period);

                numberOfPeriods = (block.timestamp - lastReleased) / custodianFee.period;
                amountToRelease = custodianFee.amount * numberOfPeriods * itemCount;
            }

            uint256 vaultAmount = vault.amount;
            if (vaultAmount < amountToRelease) {
                // release the maximum possible. The vault amount should fall below the threshold and auction should be started
                coveredPeriods = vaultAmount / (itemCount * custodianFee.amount);
                amountToRelease = coveredPeriods * custodianFee.amount * itemCount;
            } else {
                coveredPeriods = numberOfPeriods;
            }
        }

        vault.period += coveredPeriods * custodianFee.period;
        vault.amount -= amountToRelease;

        exchangeToken = offer.exchangeToken;

        increaseAvailableFunds(offer.custodianId, exchangeToken, amountToRelease);

        if (
            coveredPeriods < numberOfPeriods ||
            (isOfferVault &&
                vault.amount <
                offerLookups.custodianVaultItems * offerLookups.custodianVaultParameters.partialAuctionThreshold)
        ) {
            startFractionalAuction(offerId, tokenOrOfferId, isOfferVault, custodianFee);
        }

        emit VaultBalanceUpdated(tokenOrOfferId, vault.amount);
    }

    /**
     * @notice Places a bid in the fractional auction.
     * If the bid is successful, the funds are locked in the protocol until the auction ends or the bid is outbid.
     * When a bid is outbid, the funds are released to the previous bidder. They need to withdraw them by calling `withdrawFunds`.
     *
     * Emits BidPlaced event if successful.
     *
     * Reverts if:
     * - Custody region is paused
     * - Auction is not available
     * - Bid is too low
     * - Caller does not provide enough funds
     *
     * @param _offerId - offer ID associated with the vault
     * @param _bidAmount - amount to bid
     */
    function bid(
        uint256 _offerId,
        uint256 _bidAmount
    ) external payable notPaused(FermionTypes.PausableRegion.CustodyVault) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.FractionAuction storage fractionAuction = pl.offerLookups[_offerId].fractionAuction;

        uint256 auctionEndTime = fractionAuction.endTime;
        if (auctionEndTime == 0) revert AuctionNotStarted(_offerId);
        if (auctionEndTime < block.timestamp) revert AuctionEnded(_offerId, auctionEndTime);
        if (auctionEndTime - block.timestamp < AUCTION_END_BUFFER)
            fractionAuction.endTime = block.timestamp + AUCTION_END_BUFFER;

        uint256 previousBid = fractionAuction.maxBid;
        uint256 minimalBid = (previousBid * (HUNDRED_PERCENT + MINIMAL_BID_INCREMENT)) / HUNDRED_PERCENT;
        if (_bidAmount < minimalBid) revert InvalidBid(_offerId, minimalBid, _bidAmount);

        address exchangeToken = FermionStorage.protocolEntities().offer[_offerId].exchangeToken;

        validateIncomingPayment(exchangeToken, _bidAmount);

        // release funds to the previous bidder
        increaseAvailableFunds(fractionAuction.bidderId, exchangeToken, previousBid);

        address msgSender = _msgSender();
        uint256 bidderId = EntityLib.getOrCreateBuyerId(msgSender, pl);

        fractionAuction.maxBid = _bidAmount;
        fractionAuction.bidderId = bidderId;

        emit BidPlaced(_offerId, msgSender, bidderId, _bidAmount);
    }

    /**
     * @notice Ends and settles the fractional auction.
     * The winner gets the fractions, and the funds are stored in the vault.
     * If the end price is lower than the target price, a new auction is started.
     *
     * Emits AuctionFinished event if successful.
     *
     * Reverts if:
     * - Custody region is paused
     * - Auction is not available
     * - Auction is still ongoing
     * - Bid is too low
     * - Caller does not provide enough funds
     *
     * @param _offerId - offer ID associated with the vault
     */
    function endAuction(uint256 _offerId) external notPaused(FermionTypes.PausableRegion.CustodyVault) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.OfferLookups storage offerLookups = pl.offerLookups[_offerId];
        FermionTypes.FractionAuction storage fractionAuction = offerLookups.fractionAuction;

        uint256 auctionEndTime = fractionAuction.endTime;
        if (auctionEndTime == 0) revert AuctionNotStarted(_offerId);
        if (auctionEndTime > block.timestamp) revert AuctionOngoing(_offerId, fractionAuction.endTime);

        // fractions to the winner
        address winnerAddress = EntityLib.fetchEntityData(fractionAuction.bidderId).admin;
        uint256 soldFractions = fractionAuction.availableFractions;

        address fermionFNFTAddress = offerLookups.fermionFNFTAddress;
        IERC20(IFermionFNFT(fermionFNFTAddress).getERC20FractionsClone()).safeTransfer(winnerAddress, soldFractions);

        // release funds in the vault
        uint256 winningBid = fractionAuction.maxBid;

        fractionAuction.endTime = 0;
        fractionAuction.maxBid = 0;
        fractionAuction.bidderId = 0;
        fractionAuction.availableFractions = 0;

        FermionTypes.CustodianFee storage vault = pl.tokenLookups[_offerId].vault;
        if (vault.period == 0) {
            // equivalent to pl.custodianVaultItems[_offerId]==0
            // buyout auction for the last item in vault started after partial auction, but ended earlier
            // release proceeds directly to the custodian
            FermionTypes.Offer storage offer = FermionStorage.protocolEntities().offer[_offerId];
            increaseAvailableFunds(offer.custodianId, offer.exchangeToken, winningBid);
        } else {
            vault.amount += winningBid;
            emit VaultBalanceUpdated(_offerId, vault.amount);

            uint256 itemsInVault = offerLookups.custodianVaultItems;
            uint256 totalOfferItems = offerLookups.itemQuantity;
            uint256 firstTokenId = offerLookups.firstTokenId;
            if (vault.amount < itemsInVault * offerLookups.custodianVaultParameters.liquidationThreshold) {
                // After the auction, the vault balance is below the liquidationThreshold threshold.
                // Start partial auction for all items in the vault.
                for (uint256 i; i < totalOfferItems; i++) {
                    uint256 tokenId = firstTokenId + i;
                    fermionFNFTAddress.startAuction(tokenId);
                }
            }
        }

        emit AuctionFinished(_offerId, winnerAddress, soldFractions, winningBid);
    }

    /**
     * @notice Starts a fractional auction for the token.
     * It calculates the amount of fractions to be minted. It mints the fractions to the protocol and sets the auction details.
     * If the token was not fractionalised yet, it mints the initial amount of fractions to the token owner.
     *
     * Emits AuctionStarted events if successful.
     *
     * Reverts if:
     * - Auction for the tokenId is ongoing
     *
     * @param _offerId - the offer ID associated with the vault
     * @param _tokenId - the token ID associated with the vault (relevant for forceful fractionalisation only)
     * @param _isOfferVault - indicator whether the release was done on the offer vault (false means item vault)
     * @param _custodianFee - the custodian fee details (amount and period)
     */
    function startFractionalAuction(
        uint256 _offerId,
        uint256 _tokenId,
        bool _isOfferVault,
        FermionTypes.CustodianFee memory _custodianFee
    ) internal {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionStorage.OfferLookups storage offerLookups = pl.offerLookups[_offerId];
        FermionTypes.FractionAuction storage fractionAuction = offerLookups.fractionAuction;

        FermionTypes.CustodianVaultParameters storage vaultParameters = offerLookups.custodianVaultParameters;

        if (fractionAuction.endTime > block.timestamp) revert AuctionOngoing(_offerId, fractionAuction.endTime);

        uint256 fractionsToIssue;
        uint256 itemsInVault = offerLookups.custodianVaultItems;
        address fermionFNFTAddress = offerLookups.fermionFNFTAddress;
        if (!_isOfferVault) {
            // Forceful fractionalisation
            if (itemsInVault > 0) {
                // vault exist already
                fermionFNFTAddress.mintFractions(_tokenId, 1, 0);
                addItemToCustodianOfferVault(_tokenId, 1, 0, false, pl);
            } else {
                // no vault yet. Use the default parameters
                FermionTypes.CustodianVaultParameters memory _custodianVaultParameters;
                {
                    FermionTypes.BuyoutAuctionParameters memory _buyoutAuctionParameters;
                    _buyoutAuctionParameters.exitPrice = pl.tokenLookups[_tokenId].itemPrice;
                    uint256 partialAuctionThreshold = PARTIAL_THRESHOLD_MULTIPLIER * _custodianFee.amount;
                    uint256 newFractionsPerAuction = (partialAuctionThreshold * DEFAULT_FRACTION_AMOUNT) /
                        _buyoutAuctionParameters.exitPrice;
                    _custodianVaultParameters = FermionTypes.CustodianVaultParameters({
                        partialAuctionThreshold: partialAuctionThreshold,
                        partialAuctionDuration: _custodianFee.period / PARTIAL_AUCTION_DURATION_DIVISOR,
                        liquidationThreshold: LIQUIDATION_THRESHOLD_MULTIPLIER * _custodianFee.amount,
                        newFractionsPerAuction: newFractionsPerAuction
                    });

                    fermionFNFTAddress.mintFractions(
                        _tokenId,
                        1,
                        DEFAULT_FRACTION_AMOUNT,
                        _buyoutAuctionParameters,
                        _custodianVaultParameters,
                        0,
                        address(0)
                    );
                }
                // set the offer vault period in the past, so the auction covers the past expenses, too
                // Since this is the first fractionalisation, offer vault period should match the item vault period
                pl.tokenLookups[_offerId].vault.period = pl.tokenLookups[_tokenId].vault.period;
                setupCustodianOfferVault(_tokenId, 1, _custodianVaultParameters, 0, false);
            }

            itemsInVault++;
            vaultParameters = offerLookups.custodianVaultParameters;
        }

        uint256 auctionEnd = block.timestamp + vaultParameters.partialAuctionDuration; // if new vault was created, this vault parameters were updated
        fractionAuction.endTime = auctionEnd;
        fractionsToIssue = itemsInVault * vaultParameters.newFractionsPerAuction;

        // mint the fractions to the protocol
        fermionFNFTAddress.mintAdditionalFractions(fractionsToIssue); /// <mint to the protocol

        fractionAuction.availableFractions = fractionsToIssue;

        emit AuctionStarted(_offerId, fractionsToIssue, auctionEnd);
    }

    /**
     * @notice Returns custodian vault details.
     *
     * @param _tokenOrOfferId - the offer ID associated with the vault
     * @return vault - the custodian vault details
     * @return items - the number of items in the vault
     */
    function getCustodianVault(
        uint256 _tokenOrOfferId
    ) external view returns (FermionTypes.CustodianFee memory vault, uint256 items) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        vault = pl.tokenLookups[_tokenOrOfferId].vault;
        if (_tokenOrOfferId < (1 << 128)) {
            items = pl.offerLookups[_tokenOrOfferId].custodianVaultItems;
        } else {
            items = vault.period > 0 ? 1 : 0;
        }
    }

    /**
     * @notice Returns the partial auction details.
     *
     * @param _offerId - the offer ID associated with the vault
     * @return auction - the auction details
     */
    function getPartialAuctionDetails(
        uint256 _offerId
    ) external view returns (FermionTypes.FractionAuction memory auction) {
        return FermionStorage.protocolLookups().offerLookups[_offerId].fractionAuction;
    }

    /**
     * @notice When the first NFT is fractionalised, the custodian offer vault is setup.
     * The items' vaults are temporarily closed. If their balance was not zero, the custodian fee, proportional to the passed service time,
     * is released to the custodian and the remaining amount is transferred to the offer vault.
     *
     * Emits an VaultBalanceUpdated events
     *
     * Reverts if:
     * - Custody region is paused
     * - Call is external and caller is not the F-NFT contract owning the token
     *
     * @param _firstTokenId - the lowest token ID to add to the vault
     * @param _length - the number of tokens to add to the vault
     * @param _depositAmount - the amount to deposit
     * @param _depositAmount - the amount to deposit
     * @param _custodianVaultParameters - the custodian vault parameters
     * @param _externalCall - if true, the caller is checked to be the F-NFT contract owning the token. Use false for internal calls.
     * @return returnedAmount - the amount returned to the caller
     */
    function setupCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionTypes.CustodianVaultParameters memory _custodianVaultParameters,
        uint256 _depositAmount,
        bool _externalCall
    ) internal returns (uint256 returnedAmount) {
        // Only F-NFT contract can call it
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        uint256 offerId;
        (offerId, returnedAmount) = addItemToCustodianOfferVault(
            _firstTokenId,
            _length,
            _depositAmount,
            _externalCall,
            pl
        );

        uint256 custodianFee = FermionStorage.protocolEntities().offer[offerId].custodianFee.amount;

        // Prevents fee evasion
        if (_custodianVaultParameters.partialAuctionThreshold < custodianFee) revert InvalidPartialAuctionThreshold();

        // no need to worry this gets overwritten. If `setupCustodianOfferVault` is called the second time with the same offer it
        // it means that all items from the collection were recombined, and new parameters can be set
        pl.offerLookups[offerId].custodianVaultParameters = _custodianVaultParameters;
    }

    /** Checks if the caller is the F-NFT contract owning the token.
     *
     * Reverts if:
     * - The caller is not the F-NFT contract owning the token
     *
     * @param _offerId - offer ID associated with the vault
     * @param pl - the number of tokens to add to the vault
     */
    function verifyFermionFNFTCaller(uint256 _offerId, FermionStorage.ProtocolLookups storage pl) internal view {
        if (msg.sender != pl.offerLookups[_offerId].fermionFNFTAddress)
            revert FermionGeneralErrors.AccessDenied(msg.sender); // not using _msgSender() since the FNFT will never use meta transactions
    }
}
