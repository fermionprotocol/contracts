// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FEE_COLLECTOR } from "../../protocol/domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FundsErrors, EntityErrors, FermionGeneralErrors, OfferErrors, VerificationErrors } from "../domain/Errors.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Access } from "../bases/mixins/Access.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { MathLib } from "../libs/MathLib.sol";
import { Context } from "../bases/mixins/Context.sol";
import { IFundsEvents } from "../interfaces/events/IFundsEvents.sol";
import { FundsManager } from "../bases/mixins/FundsManager.sol";

/**
 * @title FundsFacet
 *
 * @notice Handles entity funds.
 */
contract FundsFacet is Context, FundsErrors, Access, FundsManager, IFundsEvents {
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
    ) external payable notPaused(FermionTypes.PausableRegion.Funds) nonReentrant {
        if (_amount == 0) revert ZeroDepositNotAllowed();

        // Check that entity exists. Funds to protocol entity (0) are allowed too.
        if (_entityId > 0) {
            EntityLib.validateEntityId(_entityId, FermionStorage.protocolLookups());
        }

        validateIncomingPayment(_tokenAddress, _amount);
        increaseAvailableFunds(_entityId, _tokenAddress, _amount);
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
     * - Treasury account is not associated with the entity id
     * - Token list length does not match amount list length
     * - Caller tries to withdraw more that they have in available funds
     * - There is nothing to withdraw
     * - Transfer of funds is not successful
     *
     * N.B. currently works only with entity-wide treasury and assistants. Funds handling for individual entity roles is not supported.
     *
     * @param _entityId - id of entity for which funds should be withdrawn
     * @param _treasury - account that will receive funds (must be entity's treasury)
     * @param _tokenList - list of contract addresses of tokens that are being withdrawn
     * @param _tokenAmounts - list of amounts to be withdrawn, corresponding to tokens in tokenList
     */
    function withdrawFunds(
        uint256 _entityId,
        address payable _treasury,
        address[] memory _tokenList,
        uint256[] memory _tokenAmounts
    ) external {
        if (
            !EntityLib.hasAccountRole(
                _entityId,
                _treasury,
                FermionTypes.EntityRole(0),
                FermionTypes.AccountRole.Treasury,
                true
            )
        ) revert EntityErrors.NotEntityWideRole(_treasury, _entityId, FermionTypes.AccountRole.Treasury);

        address msgSender = _msgSender();
        if (
            !EntityLib.hasAccountRole(
                _entityId,
                msgSender,
                FermionTypes.EntityRole(0),
                FermionTypes.AccountRole.Assistant,
                true
            )
        ) revert EntityErrors.NotEntityWideRole(msgSender, _entityId, FermionTypes.AccountRole.Assistant);

        withdrawFundsInternal(_entityId, _treasury, _tokenList, _tokenAmounts);
    }

    /**
     * @notice Withdraws the funds collected by the protocol.
     *
     * Emits FundsWithdrawn event if successful.
     *
     * Reverts if:
     * - Funds region is paused
     * - Caller does not have FEE_COLLECTOR role
     * - Token list length does not match amount list length
     * - Caller tries to withdraw more than they have in available funds
     * - There is nothing to withdraw
     * - Transfer of funds is not successful
     *
     * @param _tokenList - list of contract addresses of tokens that are being withdrawn
     * @param _tokenAmounts - list of amounts to be withdrawn, corresponding to tokens in tokenList
     */
    function withdrawProtocolFees(
        address[] calldata _tokenList,
        uint256[] calldata _tokenAmounts
    ) external onlyRole(FEE_COLLECTOR) {
        withdrawFundsInternal(0, FermionStorage.protocolConfig().treasury, _tokenList, _tokenAmounts);
    }

    /**
     * @notice Deposit the phygitals in the vault.
     *
     * Emits ERC721Deposited events if successful.
     *
     * Reverts if:
     * - Funds region is paused
     * - Length of _tokenIds and _phygitals does not match
     * - Offer is not with phygitals
     * - Phygitals are already verified
     * - Transfer of phygitals is not successful
     *
     * @param _tokenIds - list of FermionFNFT token ids, to which the phygitals will be deposited
     * @param _phygitals - list of addresses and phygital ids to be deposited
     */
    function depositPhygitals(uint256[] calldata _tokenIds, FermionTypes.Phygital[][] calldata _phygitals) external {
        depositOrWithdrawPhygitalInternal(_tokenIds, _phygitals, true);
    }

    /**
     * @notice Withdraw the phygitals from the vault.
     * This function is only callable by the seller and can be invoked only before the items are verified or if the item gets rejected.
     *
     * Emits ERC721Withdrawn events if successful.
     *
     * Reverts if:
     * - Funds region is paused
     * - Length of _tokenIds and _phygitals does not match
     * - Phygitals are already verified
     * - Caller is not the seller's assistant or facilitator
     * - Transfer of phygitals is not successful
     *
     * @param _tokenIds - list of FermionFNFT token ids, for which the phygitals will be deposited
     * @param _phygitals - list of addresses and phygital ids to be withdrawn
     */
    function withdrawPhygitals(uint256[] calldata _tokenIds, FermionTypes.Phygital[][] calldata _phygitals) external {
        depositOrWithdrawPhygitalInternal(_tokenIds, _phygitals, false);
    }

    /**
     * @notice Withdraw the phygitals once the items are verified.
     * This function is only callable by the buyer and can be invoked only after the items are verified.
     *
     * Emits ERC721Withdrawn events if successful.
     *
     * Reverts if:
     * - Funds region is paused
     * - Caller is not the buyer
     * - The item is not verified yet
     * - The pyhgitals are already withdrawn
     * - Transfer of phygitals is not successful
     *
     * @param _tokenIds - list of FermionFNFT token ids, for which the phygitals will be withdrawn
     * @param _treasury - account that will receive the phygitals
     */
    function withdrawPhygitals(
        uint256[] calldata _tokenIds,
        address _treasury
    ) external notPaused(FermionTypes.PausableRegion.Funds) nonReentrant {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();

        uint256 entityIdCached;
        for (uint256 i = 0; i < _tokenIds.length; i++) {
            FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[_tokenIds[i]];
            uint256 _entityId = tokenLookups.phygitalsRecipient;
            if (entityIdCached > 0) {
                // The phygitals must be withdrawn by the same entity, even if the account is the assistant for multiple entities
                if (_entityId != entityIdCached) revert FermionGeneralErrors.AccessDenied(_msgSender());
            } else {
                if (
                    !EntityLib.hasAccountRole(
                        _entityId,
                        _treasury,
                        FermionTypes.EntityRole(0),
                        FermionTypes.AccountRole.Treasury,
                        true
                    )
                ) revert EntityErrors.NotEntityWideRole(_treasury, _entityId, FermionTypes.AccountRole.Treasury);

                address msgSender = _msgSender();
                if (
                    !EntityLib.hasAccountRole(
                        _entityId,
                        msgSender,
                        FermionTypes.EntityRole(0),
                        FermionTypes.AccountRole.Assistant,
                        true
                    )
                ) revert EntityErrors.NotEntityWideRole(msgSender, _entityId, FermionTypes.AccountRole.Assistant);

                entityIdCached = _entityId;
            }

            tokenLookups.phygitalsRecipient = type(uint256).max;

            FermionTypes.Phygital[] memory phygitals = tokenLookups.phygitals; // all items are accessed, copy everything to memory
            uint256 len = phygitals.length;
            for (uint256 j; j < len; j++) {
                transferERC721FromProtocol(phygitals[j].contractAddress, _treasury, phygitals[j].tokenId);
            }

            emit PhygitalsWithdrawn(_tokenIds[i], phygitals);
        }
    }

    /**
     * @notice Collects the royalties after the buyout auction.
     *
     * Emits AvailableFundsIncreased events for every royalty recipient.
     *
     * Reverts if:
     * - Funds region is paused
     * - Caller is not the F-NFT contract owning the token
     *
     * @param _tokenId - the token id
     * @param _saleProceeds - the amount collected from the sale
     * @return royalties - the total amount of royalties collected
     */
    function collectRoyalties(
        uint256 _tokenId,
        uint256 _saleProceeds
    ) external notPaused(FermionTypes.PausableRegion.Funds) returns (uint256 royalties) {
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        (uint256 offerId, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(_tokenId);
        verifyFermionFNFTCaller(offerId, pl);

        FermionTypes.RoyaltyInfo memory royaltyInfo = offer.royaltyInfo;

        address tokenAddress = offer.exchangeToken;
        uint256 recipientsLength = royaltyInfo.recipients.length;
        for (uint256 i; i < recipientsLength; i++) {
            uint256 _entityId;
            if (royaltyInfo.recipients[i] == address(0)) {
                _entityId = offer.sellerId;
            } else {
                _entityId = EntityLib.getOrCreateEntityId(
                    royaltyInfo.recipients[i],
                    FermionTypes.EntityRole.RoyaltyRecipient,
                    pl
                );
            }

            uint256 amount = MathLib.applyPercentage(_saleProceeds, royaltyInfo.bps[i]);
            royalties += amount;

            increaseAvailableFunds(_entityId, tokenAddress, amount);
        }

        // return the remainder
        transferERC20FromProtocol(tokenAddress, payable(msg.sender), _saleProceeds - royalties);
    }

    /**
     * @notice Returns list of addresses for which the entity has funds available.
     * If the list is too long, it can be retrieved in chunks by using `getTokenListPaginated` and specifying _limit and _offset.
     *
     * @param _entityId - id of entity for which availability of funds should be checked
     * @return tokenList - list of token addresses
     */
    function getTokenList(uint256 _entityId) external view returns (address[] memory tokenList) {
        return FermionStorage.protocolLookups().entityLookups[_entityId].tokenList;
    }

    /**
     * @notice Gets the information about the available funds for an entity.
     *
     * @param _entityId - the entity ID
     * @param _token - the token address
     * @return amount - the amount available to withdraw
     */
    function getAvailableFunds(uint256 _entityId, address _token) external view returns (uint256 amount) {
        return FermionStorage.protocolLookups().entityLookups[_entityId].availableFunds[_token];
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
        address[] storage tokens = FermionStorage.protocolLookups().entityLookups[_entityId].tokenList;
        uint256 tokenCount = tokens.length;

        if (_offset >= tokenCount) {
            return new address[](0);
        } else if (_offset + _limit > tokenCount) {
            unchecked {
                _limit = tokenCount - _offset;
            }
        }

        tokenList = new address[](_limit);

        unchecked {
            for (uint256 i = 0; i < _limit; i++) {
                tokenList[i] = tokens[_offset++];
            }
        }

        return tokenList;
    }

    /**
     * @notice Gets the information about the phygitals deposited to the given FermionFNFT.
     *
     * @param _tokenId - the token ID
     * @return phygitals - a list of phygitals
     */
    function getPhygitals(uint256 _tokenId) external view returns (FermionTypes.Phygital[] memory phygitals) {
        return FermionStorage.protocolLookups().tokenLookups[_tokenId].phygitals;
    }

    /**
     * @notice Withdraws the specified funds.
     *
     * Emits FundsWithdrawn event if successful.
     *
     * Reverts if:
     * - Funds region is paused
     * - Caller is not associated with the entity id
     * - Token list length does not match amount list length
     * - Caller tries to withdraw more that they have in available funds
     * - There is nothing to withdraw
     * - Transfer of funds is not successful
     *
     * @param _destinationAddress - account that will receive funds
     * @param _entityId - entity id
     * @param _tokenList - list of contract addresses of tokens that are being withdrawn
     * @param _tokenAmounts - list of amounts to be withdrawn, corresponding to tokens in tokenList
     */
    function withdrawFundsInternal(
        uint256 _entityId,
        address payable _destinationAddress,
        address[] memory _tokenList,
        uint256[] memory _tokenAmounts
    ) internal notPaused(FermionTypes.PausableRegion.Funds) nonReentrant {
        // Cache protocol lookups for reference
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();

        // Make sure that the data is complete
        if (_tokenList.length != _tokenAmounts.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_tokenList.length, _tokenAmounts.length);

        // Two possible options: withdraw all, or withdraw only specified tokens and amounts
        if (_tokenList.length == 0) {
            // Withdraw everything

            // Get list of all user's tokens
            FermionStorage.EntityLookups storage entityLookups = pl.entityLookups[_entityId];
            address[] memory tokenList = entityLookups.tokenList;

            // Make sure that at least something will be withdrawn
            if (tokenList.length == 0) revert NothingToWithdraw();

            // Get entity's availableFunds storage pointer
            mapping(address => uint256) storage entityFunds = entityLookups.availableFunds;

            // Transfer funds
            for (uint256 i = 0; i < tokenList.length; i++) {
                // Get available funds from storage
                uint256 availableFunds = entityFunds[tokenList[i]];
                transferERC20FromProtocol(_entityId, tokenList[i], _destinationAddress, availableFunds);
            }
        } else {
            for (uint256 i = 0; i < _tokenList.length; i++) {
                // Make sure that at least something will be withdrawn
                if (_tokenAmounts[i] == 0) revert NothingToWithdraw();

                // Transfer funds
                transferERC20FromProtocol(_entityId, _tokenList[i], _destinationAddress, _tokenAmounts[i]);
            }
        }
    }

    /**
     * @notice Internal helper function for depositing or withdrawing phygitals.
     *
     * Emits PhygitalsDeposited or PhygitalsWithdrawn events if successful.
     *
     * Reverts if:
     * - Funds region is paused
     * - Length of _tokenIds and _phygitals does not match
     * - Phygitals are already verified
     * - Phygitals are being deposited and the offer is not with phygitals
     * - Phygitals are being withdrawn and the caller is not the seller's assistant or facilitator
     * - Transfer of phygitals is not successful
     *
     * @param _tokenIds - list of FermionFNFT token ids, to which the phygitals will be deposited
     * @param _phygitals - list of addresses and phygital ids to be deposited
     */
    function depositOrWithdrawPhygitalInternal(
        uint256[] calldata _tokenIds,
        FermionTypes.Phygital[][] calldata _phygitals,
        bool _isDeposit
    ) internal notPaused(FermionTypes.PausableRegion.Funds) nonReentrant {
        if (_tokenIds.length != _phygitals.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_tokenIds.length, _phygitals.length);

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();
        address msgSender = _msgSender();
        for (uint256 i = 0; i < _tokenIds.length; i++) {
            // check that the token ids exist and offer is with phygitals
            uint256 tokenId = _tokenIds[i];
            (, FermionTypes.Offer storage offer) = FermionStorage.getOfferFromTokenId(tokenId);
            if (!offer.withPhygital) revert OfferErrors.NoPhygitalOffer(tokenId);

            // check that phygitals not already verified
            FermionStorage.TokenLookups storage tokenLookups = pl.tokenLookups[tokenId];
            if (tokenLookups.phygitalsRecipient != 0) revert VerificationErrors.PhygitalsAlreadyVerified(tokenId);

            FermionTypes.Phygital[] storage phygitals = tokenLookups.phygitals;
            if (_isDeposit) {
                for (uint256 j = 0; j < _phygitals[i].length; j++) {
                    phygitals.push(_phygitals[i][j]);

                    transferERC721ToProtocol(_phygitals[i][j].contractAddress, msgSender, _phygitals[i][j].tokenId);
                }

                emit PhygitalsDeposited(tokenId, _phygitals[i]);
            } else {
                // only the seller can withdraw the phygitals
                EntityLib.validateSellerAssistantOrFacilitator(offer.sellerId, offer.facilitatorId, msgSender);
                for (uint256 j = 0; j < _phygitals[i].length; j++) {
                    {
                        uint256 len = phygitals.length;
                        bool found;
                        for (uint256 k = 0; k < len; k++) {
                            if (
                                phygitals[k].contractAddress == _phygitals[i][j].contractAddress &&
                                phygitals[k].tokenId == _phygitals[i][j].tokenId
                            ) {
                                if (k != len - 1) {
                                    phygitals[k] = phygitals[len - 1];
                                }
                                phygitals.pop();
                                found = true;
                                break;
                            }
                        }
                        if (!found) revert FundsErrors.PhygitalsNotFound(tokenId, _phygitals[i][j]);
                    }

                    transferERC721FromProtocol(_phygitals[i][j].contractAddress, msgSender, _phygitals[i][j].tokenId);

                    emit PhygitalsWithdrawn(tokenId, _phygitals[i]);
                }
            }
        }
    }
}
