// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FEE_COLLECTOR } from "../../protocol/domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FundsErrors, EntityErrors, FermionGeneralErrors } from "../domain/Errors.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { Access } from "../libs/Access.sol";
import { EntityLib } from "../libs/EntityLib.sol";
import { FundsLib } from "../libs/FundsLib.sol";
import { Context } from "../libs/Context.sol";
import { IFundsEvents } from "../interfaces/events/IFundsEvents.sol";

/**
 * @title FundsFacet
 *
 * @notice Handles entity funds.
 */
contract FundsFacet is Context, FundsErrors, Access, IFundsEvents {
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

        // Check that entity exists. Funds to protocol entity (0) are allowed too.
        if (_entityId > 0) {
            EntityLib.fetchEntityData(_entityId);
        }

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
    ) external {
        if (
            !EntityLib.hasWalletRole(
                _entityId,
                _treasury,
                FermionTypes.EntityRole(0),
                FermionTypes.WalletRole.Treasury,
                true
            )
        ) revert EntityErrors.NotEntityTreasury(_entityId, _treasury);

        address msgSender = _msgSender();
        if (
            !EntityLib.hasWalletRole(
                _entityId,
                msgSender,
                FermionTypes.EntityRole(0),
                FermionTypes.WalletRole.Assistant,
                true
            )
        ) revert EntityErrors.NotEntityAssistant(_entityId, msgSender);

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
     * - Funds region is paused
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
    ) internal notPaused(FermionTypes.PausableRegion.Funds) {
        // Cache protocol lookups for reference
        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();

        // Make sure that the data is complete
        if (_tokenList.length != _tokenAmounts.length)
            revert FermionGeneralErrors.ArrayLengthMismatch(_tokenList.length, _tokenAmounts.length);

        // Two possible options: withdraw all, or withdraw only specified tokens and amounts
        if (_tokenList.length == 0) {
            // Withdraw everything

            // Get list of all user's tokens
            address[] memory tokenList = pl.entityLookups[_entityId].tokenList;

            // Make sure that at least something will be withdrawn
            if (tokenList.length == 0) revert NothingToWithdraw();

            // Get entity's availableFunds storage pointer
            mapping(address => uint256) storage entityFunds = pl.entityLookups[_entityId].availableFunds;

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
}
