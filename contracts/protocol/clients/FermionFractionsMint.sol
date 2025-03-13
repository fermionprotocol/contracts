// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HUNDRED_PERCENT, MIN_FRACTIONS, MAX_FRACTIONS, TOP_BID_LOCK_TIME, AUCTION_DURATION, UNLOCK_THRESHOLD } from "../domain/Constants.sol";
import { FermionErrors, FermionGeneralErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
import { Common, InvalidStateOrCaller } from "./Common.sol";
import { FermionFNFTBase } from "./FermionFNFTBase.sol";
import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { IFermionFractionsEvents } from "../interfaces/events/IFermionFractionsEvents.sol";
import { IFermionCustodyVault } from "../interfaces/IFermionCustodyVault.sol";
import { IPriceOracleRegistry } from "../interfaces/IPriceOracleRegistry.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { FermionFractionsERC20 } from "./FermionFractionsERC20.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @dev Fractionalisation of NFTs
 */
contract FermionFractionsMint is FermionFNFTBase, FermionErrors, FundsLib, IFermionFractionsEvents {
    using Strings for uint256;

    // @dev The address of the ERC20 implementation contract that is used for Minimal Clone Implementation
    address private immutable erc20Implementation;

    /**
     * @notice Constructor
     * @param _bosonPriceDiscovery The address of the Boson Price Discovery contract
     * @param _erc20Implementation The address of the ERC20 implementation contract that will be cloned
     */
    constructor(
        address _bosonPriceDiscovery,
        address _erc20Implementation
    ) FermionFNFTBase(_bosonPriceDiscovery) FundsLib(bytes32(0)) {
        if (_erc20Implementation == address(0)) revert FermionGeneralErrors.InvalidAddress();
        erc20Implementation = _erc20Implementation;
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions. Sets the auction parameters and custodian vault parameters.
     * This function is called when the first NFT is fractionalised.
     * If some NFTs are already fractionalised, use `mintFractions(uint256 _firstTokenId, uint256 _length)` instead.
     *
     * @dev New epoch is advanced only when this function is called.
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
    function mintFractions(
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

        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        uint256 currentEpoch = fractionStorage.currentEpoch;
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);

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

        // if not the first epoch, we need to advance to the next epoch and set the exchange token
        uint256 newEpoch = _advanceEpoch();
        if (newEpoch != 0) {
            address exchangeToken = $.exchangeToken;
            $ = Common._getBuyoutAuctionStorage(newEpoch);
            $.exchangeToken = exchangeToken;
        }

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

        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        uint256 currentEpoch = fractionStorage.currentEpoch;
        FermionTypes.BuyoutAuctionStorage storage $ = Common._getBuyoutAuctionStorage(currentEpoch);

        uint256 nftCount = $.nftCount;
        if (nftCount == 0) {
            revert MissingFractionalisation();
        }

        uint256 fractionsAmount = Common.liquidSupply(currentEpoch) / nftCount;

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

        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        uint256 currentEpoch = fractionStorage.currentEpoch;

        FermionFractionsERC20(fractionStorage.epochToClone[currentEpoch]).mint(fermionProtocol, _amount);

        emit AdditionalFractionsMinted(_amount, Common.liquidSupply(currentEpoch));
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

        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();

        FermionFractionsERC20(fractionStorage.epochToClone[fractionStorage.currentEpoch]).mint(
            tokenOwner,
            _length * _fractionsAmount
        );

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
     * @notice Creates a new ERC20 clone for the current epoch.
     *
     * @param _epoch The epoch to create the clone for
     * @return cloneAddress The address of the created clone
     */
    function _createERC20Clone(uint256 _epoch) internal returns (address cloneAddress) {
        cloneAddress = Clones.clone(erc20Implementation);

        // Get the ERC721 storage directly
        ERC721.ERC721Storage storage erc721Storage = Common._getERC721Storage();

        // Format: name = "<fnft_name>_<epoch_index>", symbol = "<fnft_symbol><epoch_index>"
        // Only append epoch if it's not 0
        string memory _name = erc721Storage._name;
        string memory _symbol = erc721Storage._symbol;

        if (_epoch != 0) {
            string memory epochString = Strings.toString(_epoch);
            _name = string.concat(_name, "_", epochString);
            _symbol = string.concat(_symbol, epochString);
        }

        FermionFractionsERC20(cloneAddress).initialize(_name, _symbol, address(this));

        return cloneAddress;
    }

    /**
     * @dev Advances to the next epoch and creates a new ERC20 clone for the new epoch.
     * This function should be called when transitioning to a new epoch.
     * @return newEpoch The new epoch
     */
    function _advanceEpoch() internal returns (uint256 newEpoch) {
        FermionTypes.FermionFractionsStorage storage fractionStorage = Common._getFermionFractionsStorage();
        uint256 currentEpoch = fractionStorage.currentEpoch;
        uint256 arrayLength = fractionStorage.epochToClone.length;

        if (currentEpoch != 0 || arrayLength != 0) {
            newEpoch = currentEpoch + 1;
        }

        address cloneAddress = _createERC20Clone(newEpoch);
        fractionStorage.epochToClone.push(cloneAddress);
        fractionStorage.currentEpoch = newEpoch;
        return newEpoch;
    }
}
