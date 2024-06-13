// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { HUNDRED_PERCENT, AUCTION_END_BUFFER, MINIMAL_BID_INCREMENT } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Access } from "../libs/Access.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { CustodyLib } from "../libs/CustodyLib.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { ICustodyEvents } from "../interfaces/events/ICustodyEvents.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { FundsFacet } from "./Funds.sol";

/**
 * @title CustodyVaultFacet
 *
 * @notice Handles Custody Vaults and partial auctions.
 */
contract CustodyVaultFacet is Context, FermionErrors, Access, ICustodyEvents {
    uint256 private constant DEFAULT_FRACTION_AMOUNT = 1e6;
    uint256 private constant PARTIAL_THRESHOLD_MULTIPLIER = 12;
    uint256 private constant LIQUIDATION_THRESHOLD_MULTIPLIER = 3;
    uint256 private constant PARTIAL_AUCTION_DURATION_DIVISOR = 4;

    /**
     * @notice When the first NFT is fractionalised, the custodian offer vault is setup.
     * The items' vaults are temporarily closed. If their balance was not zero, the custodian fee, proportional to the passed service time,
     * is released to the custodian and the remaining amount is transferred to the offer vault.
     *
     * Only the F-NFT contract can call this function. The F-NFT contract is trusted to call this function only when the initial fractionalisation happen.
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
     */
    function setupCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionTypes.CustodianVaultParameters memory _custodianVaultParameters
    ) public notPaused(FermionTypes.PausableRegion.CustodyVault) {
        // Only F-NFT contract can call it
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        (uint256 offerId, uint256 amountToTransfer) = CustodyLib.addItemToCustodianOfferVault(
            _firstTokenId,
            _length,
            pl
        );

        if (_custodianVaultParameters.partialAuctionThreshold < _custodianVaultParameters.liquidationThreshold)
            revert InvalidThresholds();

        // no need to worry this gets overwritten. If `setupCustodianOfferVault` is called the second time with the same offer it
        // it means that all items from the collection were recombined, and new parameters can be set
        pl.custodianVaultParameters[offerId] = _custodianVaultParameters;

        FermionTypes.CustodianFee storage offerVault = pl.vault[offerId];
        offerVault.period = block.timestamp;
        offerVault.amount += amountToTransfer;

        emit VaultBalanceUpdated(offerId, offerVault.amount);
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
     */
    function addItemToCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length
    ) public notPaused(FermionTypes.PausableRegion.CustodyVault) {
        CustodyLib.addItemToCustodianOfferVault(_firstTokenId, _length, FermionStorage.protocolLookups());
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
     */
    function removeItemFromCustodianOfferVault(
        uint256 _tokenId
    ) external notPaused(FermionTypes.PausableRegion.CustodyVault) returns (uint256 released) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        // Only F-NFT contract can call it
        uint256 offerId;
        FermionTypes.Offer storage offer;
        (offerId, offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        address wrapperAddress = pl.wrapperAddress[offerId];
        if (msg.sender != wrapperAddress) revert AccessDenied(msg.sender); // not using msgSender() since the FNFT will never use meta transactions

        // trust the F-NFT contract that the token was added to offer vault at some point, i.e. it was fractionalised
        FermionTypes.CustodianFee storage offerVault = pl.vault[offerId];

        address exchangeToken = offer.exchangeToken;
        {
            FermionTypes.CustodianFee storage custodianFee = offer.custodianFee;
            uint256 vaultBalance = offerVault.amount;
            uint256 nftCount = pl.custodianVaultItems[offerId];
            uint256 itemBalance = vaultBalance / nftCount;
            uint256 lastReleased = offerVault.period;

            uint256 custodianPayoff = ((block.timestamp - lastReleased) * custodianFee.amount) / custodianFee.period;
            if (custodianPayoff > itemBalance) {
                // This happens if the vault balance fell below auction threshold and the forceful fractionalisation did not happen
                // The custodian gets everything that's in the vault, but they missed the chance to get the custodian fee via fractionalisation
                custodianPayoff = itemBalance;
                FundsLib.increaseAvailableFunds(offer.custodianId, exchangeToken, custodianPayoff);
            }

            unchecked {
                released = itemBalance - custodianPayoff;
                offerVault.amount -= itemBalance;
            }

            if (nftCount == 1) {
                // closing the offer vault
                offerVault.period = 0;
            }
            pl.custodianVaultItems[offerId];
        }

        // setup back the individual custodian vault
        CustodyLib.setupCustodianItemVault(_tokenId);

        emit VaultBalanceUpdated(offerId, offerVault.amount);

        FundsLib.transferFundsFromProtocol(exchangeToken, payable(wrapperAddress), released);
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
     * @param _tokenId - token ID associated with the vault
     * @param _amount - amount to be credited
     */
    function topUpCustodianVault(
        uint256 _tokenId,
        uint256 _amount
    ) external payable notPaused(FermionTypes.PausableRegion.CustodyVault) {
        if (_amount == 0) revert ZeroDepositNotAllowed();

        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_tokenId];

        if (vault.period == 0) revert InactiveVault(_tokenId);

        FundsLib.validateIncomingPayment(offer.exchangeToken, _amount);

        vault.amount += _amount;

        emit VaultBalanceUpdated(_tokenId, vault.amount);
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
        returns (uint256 amountToRelease, address exchangeToken)
    {
        bool isOfferVault = _tokenOrOfferId < (1 << 128);
        FermionTypes.Offer storage offer;
        uint256 offerId;
        if (isOfferVault) {
            offer = FermionStorage.protocolEntities().offer[_tokenOrOfferId];
            offerId = _tokenOrOfferId;
        } else {
            (offerId, offer) = FermionStorage.getOfferFromTokenId(_tokenOrOfferId);
        }

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.CustodianFee storage vault = pl.vault[_tokenOrOfferId];
        FermionTypes.CustodianFee memory custodianFee = offer.custodianFee;

        uint256 numberOfPeriods;
        {
            uint256 lastReleased = vault.period;
            if (lastReleased == 0) revert InactiveVault(_tokenOrOfferId);

            if (block.timestamp < lastReleased + custodianFee.period)
                revert PeriodNotOver(_tokenOrOfferId, lastReleased + custodianFee.period);

            numberOfPeriods = (block.timestamp - lastReleased) / custodianFee.period;
            amountToRelease = custodianFee.amount * numberOfPeriods;
        }

        uint256 coveredPeriods;
        uint256 vaultAmount = vault.amount;
        if (vaultAmount < amountToRelease) {
            // release the maximum possible. The vault amount should fall below the threshold and auction should be started
            coveredPeriods = vaultAmount / custodianFee.amount;
            amountToRelease = coveredPeriods * custodianFee.amount;
        } else {
            coveredPeriods = numberOfPeriods;
        }

        vault.period += coveredPeriods * custodianFee.period;
        vault.amount -= amountToRelease;

        exchangeToken = offer.exchangeToken;
        FundsLib.increaseAvailableFunds(offer.custodianId, exchangeToken, amountToRelease);

        if (
            coveredPeriods < numberOfPeriods ||
            (isOfferVault &&
                vault.amount <
                pl.custodianVaultItems[offerId] * pl.custodianVaultParameters[offerId].partialAuctionThreshold)
        ) {
            startFractionalAuction(offerId, _tokenOrOfferId, isOfferVault, custodianFee);
        }
    }

    /**
     * @notice Releases the funds from the vault and withdraw it to custodian.
     * If the vault amount falls below the custodian fee for a single period, a fractional auction is started.
     *
     * Emits VaultBalanceUpdated, AvailableFundsIncreased and FundsWithdrawn events if successful.
     *
     * Reverts if:
     * - Custody region is paused
     * - Funds region is paused
     * - Vault is not active
     * - Payment period is not over
     * - Caller is not the custodian
     * - Treasury wallet is not associated with the entity id
     * - There is nothing to withdraw
     * - Transfer of funds is not successful
     *
     * @param _tokenOrOfferId - token ID associated with the vault
     */
    function releaseFundsFromVaultAndWithdraw(
        uint256 _custodianId,
        address payable _treasury,
        uint256 _tokenOrOfferId
    ) external {
        (uint256 amountToRelease, address exchangeToken) = releaseFundsFromVault(_tokenOrOfferId);
        // ToDo: consider checking if the vault belongs to the custodian (not a security issue, just to prevent mistakes)

        address[] memory tokenList = new address[](1);
        uint256[] memory amountList = new uint256[](1);
        tokenList[0] = exchangeToken;
        amountList[0] = amountToRelease;

        // FundsLib.withdrawFunds(_custodianId, _treasury, tokenList, amountList);
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        // bytes4 functionSelector = bytes4(keccak256("myFunction(uint256)"));
        // bytes4 functionSelector = FundsFacet.withdrawFunds.selector;
        // get facet address of function
        address facet = ds.facetAddressAndSelectorPosition[FundsFacet.withdrawFunds.selector].facetAddress;
        bytes memory myFunctionCall = abi.encodeCall(
            FundsFacet.withdrawFunds,
            (_custodianId, _treasury, tokenList, amountList)
        );
        (bool success, bytes memory result) = address(facet).delegatecall(myFunctionCall);
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
     * @param _offerId - token ID associated with the vault
     * @param _bidAmount - amount to bid
     */
    function bid(uint256 _offerId, uint256 _bidAmount) external notPaused(FermionTypes.PausableRegion.CustodyVault) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.FractionAuction storage fractionAuction = pl.fractionAuction[_offerId];

        uint256 auctionEndTime = fractionAuction.endTime;
        if (auctionEndTime == 0) revert AuctionNotStarted(_offerId);
        if (auctionEndTime < block.timestamp) revert AuctionEnded(_offerId, auctionEndTime);
        if (auctionEndTime - block.timestamp < AUCTION_END_BUFFER)
            fractionAuction.endTime = block.timestamp + AUCTION_END_BUFFER;

        uint256 previousBid = fractionAuction.maxBid;
        uint256 minimalBid = (previousBid * (HUNDRED_PERCENT + MINIMAL_BID_INCREMENT)) / HUNDRED_PERCENT;
        if (_bidAmount < minimalBid) revert InvalidBid(_offerId, minimalBid, _bidAmount);

        address exchangeToken = FermionStorage.protocolEntities().offer[_offerId].exchangeToken;

        FundsLib.validateIncomingPayment(exchangeToken, _bidAmount);

        // release funds to the previous bidder
        if (previousBid > 0) {
            FundsLib.increaseAvailableFunds(fractionAuction.bidderId, exchangeToken, previousBid);
        }

        address msgSender = msgSender();
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
    function endAuction(uint256 _offerId) external notPaused(FermionTypes.PausableRegion.CustodyVault) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.FractionAuction storage fractionAuction = pl.fractionAuction[_offerId];

        uint256 auctionEndTime = fractionAuction.endTime;
        if (auctionEndTime == 0) revert AuctionNotStarted(_offerId);
        if (auctionEndTime > block.timestamp) revert AuctionOngoing(_offerId, fractionAuction.endTime);

        // fractions to the winner
        address winnerAddress = EntityLib.fetchEntityData(fractionAuction.bidderId).admin;
        uint256 soldFractions = fractionAuction.availableFractions;
        IFermionFNFT(pl.wrapperAddress[_offerId]).transfer(winnerAddress, soldFractions);

        // release funds in the vault
        uint256 winningBid = fractionAuction.maxBid;

        fractionAuction.endTime = 0;
        fractionAuction.maxBid = 0;
        fractionAuction.bidderId = 0;
        fractionAuction.availableFractions = 0;

        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_offerId];
        vault.amount += winningBid;
        emit VaultBalanceUpdated(_offerId, vault.amount);

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
     * @param _tokenOrOfferId - the token ID associated with the vault
     * @param _isOfferVault - indicator whether the release was done on the offer vault (false means item vault)
     * @param _custodianFee - the custodian fee details (amount and period)
     */
    function startFractionalAuction(
        uint256 _offerId,
        uint256 _tokenOrOfferId,
        bool _isOfferVault,
        FermionTypes.CustodianFee memory _custodianFee
    ) internal {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.FractionAuction storage fractionAuction = pl.fractionAuction[_tokenOrOfferId];

        FermionTypes.CustodianVaultParameters storage vaultParameters = pl.custodianVaultParameters[_offerId];

        if (fractionAuction.endTime > block.timestamp) revert AuctionOngoing(_tokenOrOfferId, fractionAuction.endTime);
        uint256 auctionEnd = block.timestamp + vaultParameters.partialAuctionDuration;
        fractionAuction.endTime = auctionEnd;

        uint256 fractionsToIssue;
        uint256 itemsInVault = pl.custodianVaultItems[_offerId];
        address wrapperAddress = pl.wrapperAddress[_offerId];
        if (!_isOfferVault) {
            // Forceful fractionalisation
            if (itemsInVault > 0) {
                // vault exist already
                IFermionFNFT(wrapperAddress).mintFractions(_tokenOrOfferId, 1);

                addItemToCustodianOfferVault(_tokenOrOfferId, 1);
            } else {
                // no vault yet
                FermionTypes.BuyoutAuctionParameters memory _buyoutAuctionParameters;
                _buyoutAuctionParameters.exitPrice = pl.itemPrice[_tokenOrOfferId];
                uint256 partialAuctionThreshold = PARTIAL_THRESHOLD_MULTIPLIER * _custodianFee.amount;
                uint256 newFractionsPerAuction = (partialAuctionThreshold * DEFAULT_FRACTION_AMOUNT) /
                    _buyoutAuctionParameters.exitPrice;
                FermionTypes.CustodianVaultParameters memory _custodianVaultParameters = FermionTypes
                    .CustodianVaultParameters({
                        partialAuctionThreshold: partialAuctionThreshold,
                        partialAuctionDuration: _custodianFee.period / PARTIAL_AUCTION_DURATION_DIVISOR,
                        liquidationThreshold: LIQUIDATION_THRESHOLD_MULTIPLIER * _custodianFee.amount, // todo
                        newFractionsPerAuction: newFractionsPerAuction
                    });

                IFermionFNFT(wrapperAddress).mintFractions(
                    _tokenOrOfferId,
                    1,
                    DEFAULT_FRACTION_AMOUNT,
                    _buyoutAuctionParameters,
                    _custodianVaultParameters
                );

                setupCustodianOfferVault(_tokenOrOfferId, 1, _custodianVaultParameters);
            }

            _offerId = _tokenOrOfferId >> 128;
            itemsInVault++;
            vaultParameters = pl.custodianVaultParameters[_offerId];
        }

        fractionsToIssue = itemsInVault * vaultParameters.newFractionsPerAuction;

        // mint the factions to the protocol
        IFermionFNFT(wrapperAddress).mintAdditionalFractions(fractionsToIssue); /// <mint to the protocol

        fractionAuction.availableFractions = fractionsToIssue;

        emit AuctionStarted(_offerId, fractionsToIssue, auctionEnd);
    }

    function getCustodianVault(uint256 _tokenOrOfferId) external view returns (FermionTypes.CustodianFee memory) {
        return FermionStorage.protocolLookups().vault[_tokenOrOfferId];
    }
}
