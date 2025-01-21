// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HUNDRED_PERCENT, MIN_FRACTIONS, MAX_FRACTIONS, TOP_BID_LOCK_TIME, AUCTION_DURATION, UNLOCK_THRESHOLD } from "../domain/Constants.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionFractionsERC20Base } from "./FermionFractionsERC20Base.sol";
import { Common, InvalidStateOrCaller } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";
import { IFermionCustodyVault } from "../interfaces/IFermionCustodyVault.sol";
import { IPriceOracleRegistry } from "../interfaces/IPriceOracleRegistry.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @dev Fractionalisation of NFTs
 */
contract FermionFractionsMint is
    FermionFractionsERC20Base,
    FermionFNFTBase,
    FermionErrors,
    FundsLib,
    IFermionFractionsEvents
{
    using Address for address;

    constructor(address _bosonPriceDiscovery) FermionFNFTBase(_bosonPriceDiscovery) FundsLib(bytes32(0)) {}

    /**
     * @notice Locks the F-NFTs and mints the fractions. Sets the auction parameters and custodian vault parameters.
     * This function is called when the first NFT is fractionalised.
     * If some NFTs are already fractionalised, use `mintFractions(uint256 _firstTokenId, uint256 _length)` instead.
     *
     * Emits FractionsSetup and Fractionalised events if successful.
     *
     * Reverts if:
     * - Number of tokens to fractionalise is zero
     * - Other tokens are fractionalised already
     * - Exit price is zero
     * - Fractions amount is not in the range [MIN_FRACTIONS, MAX_FRACTIONS]
     * - Token state is not Verified
     * - Token has been fractionalised already
     * - Caller is neither approved to transfer the NFTs nor is the fermion protocol
     * - The oracle is not whitelisted in the oracle registry.
     *
     * @param _firstTokenId The starting token ID
     * @param _length The number of tokens to fractionalise
     * @param _fractionsAmount The number of fractions to mint for each NFT
     * @param _buyoutAuctionParameters The buyout auction parameters
     * @param _custodianVaultParameters The custodian vault parameters
     * @param _depositAmount The amount to deposit
     * @param _priceOracle The address of the price oracle.
     */
    function mintFractionsAndSetupParameters(
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _fractionsAmount,
        FermionTypes.BuyoutAuctionParameters memory _buyoutAuctionParameters,
        FermionTypes.CustodianVaultParameters calldata _custodianVaultParameters,
        uint256 _depositAmount,
        address _priceOracle
    ) external {
        if (_length == 0) {
            revert InvalidLength();
        }

        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage();
        if ($.nftCount > 0) {
            revert InitialFractionalisationOnly();
        }

        if (_buyoutAuctionParameters.exitPrice == 0) {
            revert InvalidExitPrice(_buyoutAuctionParameters.exitPrice);
        }

        if (_buyoutAuctionParameters.unlockThreshold > HUNDRED_PERCENT) {
            revert InvalidPercentage(_buyoutAuctionParameters.unlockThreshold);
        }

        if (_fractionsAmount < MIN_FRACTIONS || _fractionsAmount > MAX_FRACTIONS) {
            revert InvalidFractionsAmount(_fractionsAmount, MIN_FRACTIONS, MAX_FRACTIONS);
        }

        if (
            _custodianVaultParameters.newFractionsPerAuction < MIN_FRACTIONS ||
            _custodianVaultParameters.newFractionsPerAuction > MAX_FRACTIONS
        ) {
            revert InvalidFractionsAmount(
                _custodianVaultParameters.newFractionsPerAuction,
                MIN_FRACTIONS,
                MAX_FRACTIONS
            );
        }

        if (_custodianVaultParameters.partialAuctionThreshold < _custodianVaultParameters.liquidationThreshold)
            revert InvalidPartialAuctionThreshold();

        lockNFTsAndMintFractions(_firstTokenId, _length, _fractionsAmount, $);

        if (_priceOracle != address(0)) {
            if (!_isOracleApproved(_priceOracle)) revert PriceOracleNotWhitelisted(_priceOracle);
            $.priceOracle = _priceOracle;
        }

        // set the default values if not provided
        if (_buyoutAuctionParameters.duration == 0) _buyoutAuctionParameters.duration = AUCTION_DURATION;
        if (_buyoutAuctionParameters.unlockThreshold == 0) _buyoutAuctionParameters.unlockThreshold = UNLOCK_THRESHOLD;
        if (_buyoutAuctionParameters.topBidLockTime == 0) _buyoutAuctionParameters.topBidLockTime = TOP_BID_LOCK_TIME;

        $.auctionParameters = _buyoutAuctionParameters;

        emit FractionsSetup(_fractionsAmount, _buyoutAuctionParameters);

        address msgSender = _msgSender();
        if (msgSender != fermionProtocol) {
            moveDepositToFermionProtocol(_depositAmount, $);
            uint256 returnedAmount = IFermionCustodyVault(fermionProtocol).setupCustodianOfferVault(
                _firstTokenId,
                _length,
                _custodianVaultParameters,
                _depositAmount
            );
            if (returnedAmount > 0) transferERC20FromProtocol($.exchangeToken, payable(msgSender), returnedAmount);
        }
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions. The number of fractions matches the number of fractions for existing NFTs.
     * This function is called when additional NFTs are fractionalised.
     *
     * Reverts if:
     * - Number of tokens to fractionalise is zero
     * - No tokens are fractionalised already
     * - Token state is not Verified
     * - Token has been fractionalised already
     * - Caller is neither approved to transfer the NFTs nor is the fermion protocol
     *
     * @param _firstTokenId The starting token ID
     * @param _length The number of tokens to fractionalise
     * @param _depositAmount - the amount to deposit
     */
    function mintFractions(uint256 _firstTokenId, uint256 _length, uint256 _depositAmount) external {
        if (_length == 0) {
            revert InvalidLength();
        }

        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage();
        uint256 nftCount = $.nftCount;
        if (nftCount == 0) {
            revert MissingFractionalisation();
        }

        uint256 fractionsAmount = liquidSupply() / nftCount;

        lockNFTsAndMintFractions(_firstTokenId, _length, fractionsAmount, $);

        address msgSender = _msgSender();
        if (msgSender != fermionProtocol) {
            moveDepositToFermionProtocol(_depositAmount, $);
            uint256 returnedAmount = IFermionCustodyVault(fermionProtocol).addItemToCustodianOfferVault(
                _firstTokenId,
                _length,
                _depositAmount
            );
            if (returnedAmount > 0) transferERC20FromProtocol($.exchangeToken, payable(msgSender), returnedAmount);
        }
    }

    /**
     * @notice Mints additional fractions to be sold in the partial auction to fill the custodian vault.
     *
     * Emits AdditionalFractionsMinted event if successful.
     *
     * Reverts if:
     * - The caller is not the fermion protocol
     *
     * N.B. The protocol is trusted to mint the correct number of fractions
     *
     * @param _amount The number of fractions to mint
     */
    function mintAdditionalFractions(uint256 _amount) external {
        if (_msgSender() != fermionProtocol) {
            revert AccessDenied(_msgSender());
        }

        _mintFractions(fermionProtocol, _amount);

        emit AdditionalFractionsMinted(_amount, liquidSupply());
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions.
     *
     * Reverts if:
     * - Number of tokens to fractionalise is zero
     * - No tokens are fractionalised already
     * - Token state is not Verified
     * - Token has been fractionalised already
     * - Caller is neither approved to transfer the NFTs nor is the fermion protocol
     *
     * @param _firstTokenId The starting token ID
     * @param _length The number of tokens to fractionalise
     */
    function lockNFTsAndMintFractions(
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _fractionsAmount,
        FermionTypes.BuyoutAuctionStorage storage $
    ) internal {
        address tokenOwner = ownerOf(_firstTokenId); // all tokens must be owned by the same address

        for (uint256 i = 0; i < _length; i++) {
            uint256 tokenId = _firstTokenId + i;
            FermionTypes.TokenState tokenState = Common._getFermionCommonStorage().tokenState[tokenId];

            if (tokenState != FermionTypes.TokenState.CheckedIn)
                revert InvalidStateOrCaller(tokenId, _msgSender(), tokenState);

            if (_msgSender() == fermionProtocol) {
                // forceful fractionalisation
                // not caching Common._getERC721Storage(), since protocol will fractionalize 1 by 1
                Common._getERC721Storage()._tokenApprovals[tokenId] = fermionProtocol;
            }

            ERC721.transferFrom(tokenOwner, address(this), tokenId);
            FermionTypes.TokenAuctionInfo storage tokenInfo = $.tokenInfo[tokenId];
            tokenInfo.isFractionalised = true;
            tokenInfo.auctions.push();

            emit Fractionalised(tokenId, _fractionsAmount);
        }

        _mintFractions(tokenOwner, _length * _fractionsAmount);

        $.nftCount += _length;
    }

    /**
     * @notice Transfers the deposit to the Fermion Protocol during fractionalisation
     *
     * @param _depositAmount The amount to deposit
     * @param $ The storage
     */
    function moveDepositToFermionProtocol(
        uint256 _depositAmount,
        FermionTypes.BuyoutAuctionStorage storage $
    ) internal {
        if (_depositAmount > 0) {
            address exchangeToken = $.exchangeToken;
            validateIncomingPayment(exchangeToken, _depositAmount);
            transferERC20FromProtocol(exchangeToken, payable(fermionProtocol), _depositAmount);
        }
    }

    /**
     * @notice Checks if the given oracle is approved in the oracle registry.
     *
     * @param _oracle The address of the price oracle to check.
     * @return isApproved True if the oracle is approved, otherwise false.
     */
    function _isOracleApproved(address _oracle) internal view returns (bool) {
        return IPriceOracleRegistry(fermionProtocol).isPriceOracleApproved(_oracle);
    }

    /**
     * @notice Returns the number of fractions. Represents the ERC20 balanceOf method
     *
     * @param _owner The address to check
     */
    function balanceOf(
        address _owner
    ) public view virtual override(ERC721, FermionFractionsERC20Base) returns (uint256) {
        return FermionFractionsERC20Base.balanceOf(_owner);
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `value`.
     */
    function transfer(address to, uint256 value) public virtual override returns (bool) {
        return FermionFractionsERC20Base.transfer(to, value);
    }
}
