// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { HUNDRED_PERCENT, AUCTION_END_BUFFER, MINIMAL_BID_INCREMENT } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Access } from "../libs/Access.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { IFundsEvents } from "../interfaces/events/IFundsEvents.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";

/**
 * @title FundsFacet
 *
 * @notice Handles entity funds.
 */
contract FundsFacet is Context, FermionErrors, Access, IFundsEvents {
    uint256 private constant DEFAULT_FRACTION_AMOUNT = 1e6;
    uint256 private constant FRACTION_AUCTION_DURATION = 1 weeks; // ToDo: make it a protocol parameter

    /**
     * @notice Receives funds from the caller, maps funds to the entity id and stores them so they can be used during unwrapping.
     *
     * Emits AvailableFundsIncreased event if successful.
     *
     * Reverts if:
     * - Funds region is paused
     * - Amount to deposit is zero
     * - Entity does not exist
     * - Exchange token is native token and caller does not send enough
     * - Exchange token is some ERC20 token and caller also sends native currency
     * - Contract at token address does not support ERC20 function transferFrom
     * - Calling transferFrom on token fails for some reason (e.g. protocol is not approved to transfer)
     * - Received token amount differs from the expected value
     *
     * @param _entityId - id of the entity that will be credited
     * @param _tokenAddress - contract address of token that is being deposited (0 for native currency)
     * @param _amount - amount to be credited
     */
    function depositFunds(
        uint256 _entityId,
        address _tokenAddress,
        uint256 _amount
    ) external payable notPaused(FermionTypes.PausableRegion.Funds) {
        if (_amount == 0) revert ZeroDepositNotAllowed();

        // Check that entity exists
        EntityLib.fetchEntityData(_entityId);

        FundsLib.validateIncomingPayment(_tokenAddress, _amount);
        FundsLib.increaseAvailableFunds(_entityId, _tokenAddress, _amount);
    }

    /**
     * @notice Withdraws the specified funds.
     *
     * Emits FundsWithdrawn event if successful.
     *
     * Reverts if:
     * - Funds region is paused
     * - Entity does not exist
     * - Caller is not associated with the entity id
     * - Treasury wallet is not associated with the entity id
     * - Token list length does not match amount list length
     * - Caller tries to withdraw more that they have in available funds
     * - There is nothing to withdraw
     * - Transfer of funds is not successful
     *
     * N.B. currently works only with entity-wide treasury and assistants. Funds handling for individual entity roles is not supported.
     *
     * @param _entityId - id of entity for which funds should be withdrawn
     * @param _treasury - wallet that will receive funds (must be entity's treasury)
     * @param _tokenList - list of contract addresses of tokens that are being withdrawn
     * @param _tokenAmounts - list of amounts to be withdrawn, corresponding to tokens in tokenList
     */
    function withdrawFunds(
        uint256 _entityId,
        address payable _treasury,
        address[] memory _tokenList,
        uint256[] memory _tokenAmounts
    ) public notPaused(FermionTypes.PausableRegion.Funds) {
        if (
            !EntityLib.hasWalletRole(
                _entityId,
                _treasury,
                FermionTypes.EntityRole(0),
                FermionTypes.WalletRole.Treasury,
                true
            )
        ) revert NotEntityTreasury(_entityId, _treasury);

        address msgSender = msgSender();
        if (
            !EntityLib.hasWalletRole(
                _entityId,
                msgSender,
                FermionTypes.EntityRole(0),
                FermionTypes.WalletRole.Assistant,
                true
            )
        ) revert NotEntityAssistant(_entityId, msgSender);

        withdrawFundsInternal(_entityId, _treasury, _tokenList, _tokenAmounts);
    }

    /**
     * @notice Receives funds from the caller, and tops up the custodian vault.
     *
     * Emits VaultAmountUpdated event if successful.
     *
     * Reverts if:
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
    function topUpCustodianVault(uint256 _tokenId, uint256 _amount) external payable {
        if (_amount == 0) revert ZeroDepositNotAllowed();

        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_tokenId];

        if (vault.period == 0) revert InactiveVault(_tokenId);

        FundsLib.validateIncomingPayment(offer.exchangeToken, _amount);

        vault.amount += _amount;

        emit VaultAmountUpdated(_tokenId, vault.amount);
    }

    /**
     * @notice Releases the funds from the vault to the custodian.
     * Custodian must call withdrawFunds to get the funds.
     * If the vault amount falls below the custodian fee for a single period, a fractional auction is started.
     *
     * Emits VaultAmountUpdated and AvailableFundsIncreased events if successful.
     *
     * Reverts if:
     * - Vault is not active
     * - Payment period is not over
     *
     * @param _tokenId - token ID associated with the vault
     */
    function releaseFundsFromVault(uint256 _tokenId) public returns (uint256 amountToRelease, address exchangeToken) {
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);

        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_tokenId];
        uint256 vaultPeriodEnd = vault.period;
        if (vaultPeriodEnd == 0) revert InactiveVault(_tokenId);

        FermionTypes.CustodianFee memory custodianFee = offer.custodianFee;

        uint256 vaultAmount = vault.amount;

        if (block.timestamp < vaultPeriodEnd) revert PeriodNotOver(_tokenId, vaultPeriodEnd);

        uint256 numberOfPeriods = (block.timestamp - vaultPeriodEnd) / custodianFee.period;
        amountToRelease = custodianFee.amount * numberOfPeriods;
        uint256 coveredPeriods;

        if (vaultAmount < amountToRelease) {
            // release the maximum possible and start the auction
            coveredPeriods = vaultAmount / custodianFee.amount;
            amountToRelease = coveredPeriods * custodianFee.amount;
        } else {
            coveredPeriods = numberOfPeriods;
        }

        vault.period += coveredPeriods * custodianFee.period;
        vault.amount -= amountToRelease;

        FundsLib.increaseAvailableFunds(offer.custodianId, offer.exchangeToken, amountToRelease);

        if (vault.amount < custodianFee.amount) {
            // cover 1 period + uncovered periods
            uint256 missingAmount = (numberOfPeriods - coveredPeriods + 1) * custodianFee.amount;

            startFractionalAuction(offerId, _tokenId, missingAmount);
        }

        exchangeToken = offer.exchangeToken;
    }

    /**
     * @notice Releases the funds from the vault and withdraw it to custodian.
     * If the vault amount falls below the custodian fee for a single period, a fractional auction is started.
     *
     * Emits VaultAmountUpdated, AvailableFundsIncreased and FundsWithdrawn events if successful.
     *
     * Reverts if:
     * - Vault is not active
     * - Payment period is not over
     * - Caller is not the custodian
     * - Treasury wallet is not associated with the entity id
     * - There is nothing to withdraw
     * - Transfer of funds is not successful
     *
     * @param _tokenId - token ID associated with the vault
     */
    function releaseFundsFromVaultAndWithdraw(
        uint256 _custodianId,
        address payable _treasury,
        uint256 _tokenId
    ) external {
        (uint256 amountToRelease, address exchangeToken) = releaseFundsFromVault(_tokenId);
        // ToDo: consider checking if the vault belongs to the custodian (not a security issue, just to prevent mistakes)

        address[] memory tokenList = new address[](1);
        uint256[] memory amountList = new uint256[](1);
        tokenList[0] = exchangeToken;
        amountList[0] = amountToRelease;

        withdrawFunds(_custodianId, _treasury, tokenList, amountList);
    }

    /**
     * @notice Places a bid in the fractional auction.
     * If the bid is successful, the funds are locked in the protocol until the auction ends or the bid is outbid.
     * When a bid is outbid, the funds are released to the previous bidder. They need to withdraw them by calling `withdrawFunds`.
     *
     * Emits BidPlaced event if successful.
     *
     * Reverts if:
     * - Auction is not available
     * - Bid is too low
     * - Caller does not provide enough funds
     *
     * @param _tokenId - token ID associated with the vault
     * @param _bidAmount - amount to bid
     */
    function bid(uint256 _tokenId, uint256 _bidAmount) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.FractionAuction storage fractionAuction = pl.fractionAuction[_tokenId];

        uint256 auctionEndTime = fractionAuction.endTime;
        if (auctionEndTime == 0) revert AuctionNotStarted(_tokenId);
        if (auctionEndTime < block.timestamp) revert AuctionEnded(_tokenId, auctionEndTime);
        if (auctionEndTime - block.timestamp < AUCTION_END_BUFFER)
            fractionAuction.endTime = block.timestamp + AUCTION_END_BUFFER;

        uint256 previousBid = fractionAuction.maxBid;
        uint256 minimalBid = (previousBid * (HUNDRED_PERCENT + MINIMAL_BID_INCREMENT)) / HUNDRED_PERCENT;
        if (_bidAmount < minimalBid) revert InvalidBid(_tokenId, minimalBid, _bidAmount);

        (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        address exchangeToken = offer.exchangeToken;

        FundsLib.validateIncomingPayment(exchangeToken, _bidAmount);

        // release funds to the previous bidder
        if (previousBid > 0) {
            FundsLib.increaseAvailableFunds(fractionAuction.bidderId, offer.exchangeToken, previousBid);
        }

        address msgSender = msgSender();
        uint256 bidderId = EntityLib.getOrCreateBuyerId(msgSender, pl);

        fractionAuction.maxBid = _bidAmount;
        fractionAuction.bidderId = bidderId;

        emit BidPlaced(_tokenId, msgSender, bidderId, _bidAmount);
    }

    /**
     * @notice Ends and settles the fractional auction.
     * The winner gets the fractions, and the funds are stored in the vault.
     * If the end price is lower than the target price, a new auction is started.
     *
     * Emits AuctionFinished event if successful.
     *
     * Reverts if:
     * - Auction is not available
     * - Auction is still ongoing
     * - Bid is too low
     * - Caller does not provide enough funds
     *
     * @param _tokenId - token ID associated with the vault
     */
    function endAuction(uint256 _tokenId) external {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.FractionAuction storage fractionAuction = pl.fractionAuction[_tokenId];

        uint256 auctionEndTime = fractionAuction.endTime;
        if (auctionEndTime == 0) revert AuctionNotStarted(_tokenId);
        if (auctionEndTime > block.timestamp) revert AuctionOngoing(_tokenId, fractionAuction.endTime);

        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        address wrapperAddress = pl.wrapperAddress[offerId];

        // fractions to the winner
        address winnerAddress = EntityLib.fetchEntityData(fractionAuction.bidderId).admin;
        uint256 soldFractions = fractionAuction.availableFractions;
        IFermionFNFT(wrapperAddress).transfer(winnerAddress, soldFractions);

        // release funds in the vault
        uint256 winningBid = fractionAuction.maxBid;

        // calculate implied price
        (, uint256 nftCount, uint256 totalSupply) = IFermionFNFT(wrapperAddress).getFractionInfo();

        fractionAuction.lastPrice = (totalSupply * winningBid) / (nftCount * soldFractions);
        fractionAuction.endTime = 0;
        fractionAuction.maxBid = 0;
        fractionAuction.bidderId = 0;
        fractionAuction.availableFractions = 0;

        FermionTypes.CustodianFee storage vault = FermionStorage.protocolLookups().vault[_tokenId];
        if (winningBid < fractionAuction.targetPrice) {
            vault.amount += winningBid;
            // start a new auction
            startFractionalAuction(offerId, _tokenId, fractionAuction.targetPrice - winningBid);
        } else {
            fractionAuction.targetPrice = 0;
            vault.amount += (winningBid - fractionAuction.targetPrice);
            // release funds to custodian?
            FundsLib.increaseAvailableFunds(offer.custodianId, offer.exchangeToken, fractionAuction.targetPrice);
        }

        emit AuctionFinished(_tokenId, winnerAddress, soldFractions, winningBid);
    }

    /**
     * @notice Returns list of addresses for which the entity has funds available.
     * If the list is too long, it can be retrieved in chunks by using `getTokenListPaginated` and specifying _limit and _offset.
     *
     * @param _entityId - id of entity for which availability of funds should be checked
     * @return tokenList - list of token addresses
     */
    function getTokenList(uint256 _entityId) external view returns (address[] memory tokenList) {
        return FermionStorage.protocolLookups().tokenList[_entityId];
    }

    /**
     * @notice Gets the information about the available funds for an entity.
     *
     * @param _entityId - the entity ID
     * @param _token - the token address
     * @return amount - the amount available to withdraw
     */
    function getAvailableFunds(uint256 _entityId, address _token) external view returns (uint256 amount) {
        return FermionStorage.protocolLookups().availableFunds[_entityId][_token];
    }

    /**
     * @notice Returns list of addresses for which the entity has funds available.
     *
     * @param _entityId - id of entity for which availability of funds should be checked
     * @param _limit - the maximum number of token addresses that should be returned starting from the index defined by `_offset`. If `_offset` + `_limit` exceeds total tokens, `_limit` is adjusted to return all remaining tokens.
     * @param _offset - the starting index from which to return token addresses. If `_offset` is greater than or equal to total tokens, an empty list is returned.
     * @return tokenList - list of token addresses
     */
    function getTokenListPaginated(
        uint256 _entityId,
        uint256 _limit,
        uint256 _offset
    ) external view returns (address[] memory tokenList) {
        address[] storage tokens = FermionStorage.protocolLookups().tokenList[_entityId];
        uint256 tokenCount = tokens.length;

        if (_offset >= tokenCount) {
            return new address[](0);
        } else if (_offset + _limit > tokenCount) {
            _limit = tokenCount - _offset;
        }

        tokenList = new address[](_limit);

        for (uint256 i = 0; i < _limit; i++) {
            tokenList[i] = tokens[_offset++];
        }

        return tokenList;
    }

    /**
     * @notice Withdraws the specified funds.
     *
     * Emits FundsWithdrawn event if successful.
     *
     * Reverts if:
     * - Caller is not associated with the entity id
     * - Token list length does not match amount list length
     * - Caller tries to withdraw more that they have in available funds
     * - There is nothing to withdraw
     * - Transfer of funds is not successful
     *
     * @param _destinationAddress - wallet that will receive funds
     * @param _entityId - entity id
     * @param _tokenList - list of contract addresses of tokens that are being withdrawn
     * @param _tokenAmounts - list of amounts to be withdrawn, corresponding to tokens in tokenList
     */
    function withdrawFundsInternal(
        uint256 _entityId,
        address payable _destinationAddress,
        address[] memory _tokenList,
        uint256[] memory _tokenAmounts
    ) internal {
        // Cache protocol lookups for reference
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();

        // Make sure that the data is complete
        if (_tokenList.length != _tokenAmounts.length)
            revert ArrayLengthMismatch(_tokenList.length, _tokenAmounts.length);

        // Two possible options: withdraw all, or withdraw only specified tokens and amounts
        if (_tokenList.length == 0) {
            // Withdraw everything

            // Get list of all user's tokens
            address[] memory tokenList = pl.tokenList[_entityId];

            // Make sure that at least something will be withdrawn
            if (tokenList.length == 0) revert NothingToWithdraw();

            // Get entity's availableFunds storage pointer
            mapping(address => uint256) storage entityFunds = pl.availableFunds[_entityId];

            // Transfer funds
            for (uint256 i = 0; i < tokenList.length; i++) {
                // Get available funds from storage
                uint256 availableFunds = entityFunds[tokenList[i]];
                FundsLib.transferFundsFromProtocol(_entityId, tokenList[i], _destinationAddress, availableFunds);
            }
        } else {
            for (uint256 i = 0; i < _tokenList.length; i++) {
                // Make sure that at least something will be withdrawn
                if (_tokenAmounts[i] == 0) revert NothingToWithdraw();

                // Transfer funds
                FundsLib.transferFundsFromProtocol(_entityId, _tokenList[i], _destinationAddress, _tokenAmounts[i]);
            }
        }
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
     * @param _tokenId - the token ID associated with the vault
     * @param _amountToRaise - the target amount to raise in the auction
     */
    function startFractionalAuction(uint256 _offerId, uint256 _tokenId, uint256 _amountToRaise) internal {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        FermionTypes.FractionAuction storage fractionAuction = pl.fractionAuction[_tokenId];

        if (fractionAuction.endTime > block.timestamp) revert AuctionOngoing(_tokenId, fractionAuction.endTime);
        fractionAuction.endTime = block.timestamp + FRACTION_AUCTION_DURATION;

        uint256 price = fractionAuction.lastPrice;

        address wrapperAddress = pl.wrapperAddress[_offerId];
        (uint256 exitPrice, uint256 nftCount, uint256 totalSupply) = IFermionFNFT(wrapperAddress).getFractionInfo();

        if (price == 0) {
            // no fraction auctions yet
            if (exitPrice == 0) {
                // item was not fractionalised yet
                price = pl.itemPrice[_tokenId]; // maybe add 10%
                unchecked {
                    uint256 amountToMint = nftCount == 0 ? DEFAULT_FRACTION_AMOUNT : totalSupply / nftCount;
                    IFermionFNFT(wrapperAddress).mintFractions(_tokenId, 1); /// <if first, use the other method
                    nftCount++;
                    totalSupply += amountToMint;
                }
            } else {
                price = exitPrice;
            }
        }

        uint256 fractionsToIssue;
        if (price <= _amountToRaise) {
            fractionsToIssue = DEFAULT_FRACTION_AMOUNT;
        }

        unchecked {
            uint256 tokenIndividialFractions = totalSupply / nftCount;
            fractionsToIssue = (_amountToRaise * tokenIndividialFractions) / (price - _amountToRaise);
            // Can this be 0? How to handle it?
        }

        // mint the factions to the protocol
        IFermionFNFT(wrapperAddress).mintAdditionalFractions(fractionsToIssue); /// <mint to the protocol

        fractionAuction.availableFractions = fractionsToIssue;
        fractionAuction.targetPrice = _amountToRaise;

        emit AuctionStarted(_tokenId, fractionsToIssue, _amountToRaise, fractionAuction.endTime);
    }
}
