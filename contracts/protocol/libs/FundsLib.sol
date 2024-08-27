// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HUNDRED_PERCENT } from "../domain/Constants.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { FundsErrors, FermionGeneralErrors } from "../domain/Errors.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { ContextLib } from "../libs/Context.sol";
import { IFundsEvents } from "../interfaces/events/IFundsEvents.sol";

/**
 * @title FundsLib
 *
 * @dev
 */
library FundsLib {
    using SafeERC20 for IERC20;

    /**
     * @notice Validates that incoming payments matches expectation. If token is a native currency, it makes sure
     * msg.value is correct. If token is ERC20, it transfers the value from the sender to the protocol.
     *
     * Reverts if:
     * - Exchange token is native token and caller does not send enough
     * - Exchange token is some ERC20 token and caller also sends native currency
     * - Contract at token address does not support ERC20 function transferFrom
     * - Calling transferFrom on token fails for some reason (e.g. protocol is not approved to transfer)
     * - Received ERC20 token amount differs from the expected value
     *
     * @param _exchangeToken - address of the token (0x for native currency)
     * @param _value - value expected to receive
     */
    function validateIncomingPayment(address _exchangeToken, uint256 _value) internal {
        if (_exchangeToken == address(0)) {
            // if transfer is in the native currency, msg.value must match offer price
            if (msg.value != _value) revert FundsErrors.WrongValueReceived(_value, msg.value);
        } else {
            // when price is in an erc20 token, transferring the native currency is not allowed
            if (msg.value != 0) revert FundsErrors.NativeNotAllowed();

            // if transfer is in ERC20 token, try to transfer the amount from buyer to the protocol
            transferFundsToProtocol(_exchangeToken, ContextLib._msgSender(), _value);
        }
    }

    /**
     * @notice Tries to transfer tokens from the caller to the protocol.
     *
     * Reverts if:
     * - The called contract is ERC721
     * - Contract at token address does not support ERC20 function transferFrom
     * - Calling transferFrom on token fails for some reason (e.g. protocol is not approved to transfer)
     * - Received ERC20 token amount differs from the expected value
     *
     * N.B. Special caution is needed when interacting with the FermionFNFT contract,
     * as it treats _msgSender() differently when the caller is the Fermion protocol.
     * Currently, interactions with FermionFNFT in this function are prevented
     * because it returns true for IERC165.supportsInterface(IERC721) and reverts.
     * If this check is removed, a special check should be introduced to prevent FermionFNFT interactions.
     * Alternatively, if interactions with FermionFNFT become allowed at some point,
     * those interactions should be conducted via FermionFNFTLib to ensure the correct _msgSender() is used.
     *
     * @param _tokenAddress - address of the token to be transferred
     * @param _from - address to transfer funds from
     * @param _amount - amount to be transferred
     */
    function transferFundsToProtocol(address _tokenAddress, address _from, uint256 _amount) internal {
        // prevent ERC721 deposits
        (bool success, bytes memory returnData) = _tokenAddress.staticcall(
            abi.encodeCall(IERC165.supportsInterface, (type(IERC721).interfaceId))
        );

        if (success) {
            if (returnData.length != 32) {
                revert FermionGeneralErrors.UnexpectedDataReturned(returnData);
            } else {
                // If returned value equals 1 (= true), the contract is ERC721 and we should revert
                uint256 result = abi.decode(returnData, (uint256)); // decoding into uint256 not bool to cover all cases
                if (result == 1) {
                    revert FundsErrors.ERC721NotAllowed(_tokenAddress);
                } else if (result > 1) {
                    revert FermionGeneralErrors.UnexpectedDataReturned(returnData);
                }
                // If returned value equals 0 (= false), the contract is not ERC721 and we can continue.
            }
        } else {
            if (returnData.length == 0) {
                // Do nothing. ERC20 not implementing IERC721 interface is expected to revert without reason
            } else {
                // If an actual error message is returned, revert with it
                /// @solidity memory-safe-assembly
                assembly {
                    revert(add(32, returnData), mload(returnData))
                }
            }
        }

        // protocol balance before the transfer
        uint256 protocolTokenBalanceBefore = IERC20(_tokenAddress).balanceOf(address(this));

        // transfer ERC20 tokens from the caller
        IERC20(_tokenAddress).safeTransferFrom(_from, address(this), _amount);

        // protocol balance after the transfer
        uint256 protocolTokenBalanceAfter = IERC20(_tokenAddress).balanceOf(address(this));

        // make sure that expected amount of tokens was transferred
        uint256 receivedAmount = protocolTokenBalanceAfter - protocolTokenBalanceBefore;
        if (receivedAmount != _amount) revert FundsErrors.WrongValueReceived(_amount, receivedAmount);
    }

    /**
     * @notice Increases the amount, available to withdraw.
     *
     * @param _entityId - id of entity for which funds should be increased, or 0 for protocol
     * @param _tokenAddress - funds contract address or zero address for native currency
     * @param _amount - amount to be credited
     */
    function increaseAvailableFunds(uint256 _entityId, address _tokenAddress, uint256 _amount) internal {
        if (_amount == 0) return;

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();

        // if the current amount of token is 0, the token address must be added to the token list
        FermionStorage.EntityLookups storage entityLookups = pl.entityLookups[_entityId];
        mapping(address => uint256) storage availableFunds = entityLookups.availableFunds;
        if (availableFunds[_tokenAddress] == 0) {
            address[] storage tokenList = entityLookups.tokenList;
            tokenList.push(_tokenAddress);
            //Set index mapping. Should be index in tokenList array + 1
            pl.tokenIndexByAccount[_entityId][_tokenAddress] = tokenList.length;
        }

        // update the available funds
        availableFunds[_tokenAddress] += _amount;

        emit IFundsEvents.AvailableFundsIncreased(_entityId, _tokenAddress, _amount);
    }

    /**
     * @notice Tries to transfer native currency or tokens from the protocol to the recipient.
     *
     * Emits FundsWithdrawn event if successful.
     *
     * Reverts if:
     * - Transfer of native currency is not successful (i.e. recipient is a contract which reverts)
     * - Contract at token address does not support ERC20 function transfer
     * - Available funds is less than amount to be decreased
     *
     * @param _entityId - id of entity for which funds should be decreased, or 0 for protocol
     * @param _tokenAddress - address of the token to be transferred
     * @param _to - address of the recipient
     * @param _amount - amount to be transferred
     */
    function transferFundsFromProtocol(
        uint256 _entityId,
        address _tokenAddress,
        address payable _to,
        uint256 _amount
    ) internal {
        // first decrease the amount to prevent the reentrancy attack
        decreaseAvailableFunds(_entityId, _tokenAddress, _amount);

        // try to transfer the funds
        transferFundsFromProtocol(_tokenAddress, _to, _amount);

        // notify the external observers
        emit IFundsEvents.FundsWithdrawn(_entityId, _to, _tokenAddress, _amount);
    }

    /**
     * @notice Tries to transfer native currency or tokens from the protocol to the recipient.
     *
     * Reverts if:
     * - Transfer of native currency is not successful (i.e. recipient is a contract which reverts)
     * - Contract at token address does not support ERC20 function transfer
     * - Available funds is less than amount to be decreased
     *
     * @param _tokenAddress - address of the token to be transferred
     * @param _to - address of the recipient
     * @param _amount - amount to be transferred
     */
    function transferFundsFromProtocol(address _tokenAddress, address payable _to, uint256 _amount) internal {
        // try to transfer the funds
        if (_tokenAddress == address(0)) {
            // transfer native currency
            (bool success, bytes memory errorMessage) = _to.call{ value: _amount }("");
            if (!success) revert FundsErrors.TokenTransferFailed(_to, _amount, errorMessage);
        } else {
            // transfer ERC20 tokens
            IERC20(_tokenAddress).safeTransfer(_to, _amount);
        }
    }

    /**
     * @notice Decreases the amount available to withdraw or use as a seller deposit.
     *
     * Reverts if:
     * - Available funds is less than amount to be decreased
     *
     * @param _entityId - id of entity for which funds should be decreased, or 0 for protocol
     * @param _tokenAddress - funds contract address or zero address for native currency
     * @param _amount - amount to be taken away
     */
    function decreaseAvailableFunds(uint256 _entityId, address _tokenAddress, uint256 _amount) internal {
        if (_amount == 0) return;

        FermionStorage.ProtocolLookups storage pl = FermionStorage.protocolLookups();

        // get available funds from storage
        FermionStorage.EntityLookups storage entityLookups = pl.entityLookups[_entityId];
        mapping(address => uint256) storage availableFunds = entityLookups.availableFunds;
        uint256 entityFunds = availableFunds[_tokenAddress];

        // make sure that seller has enough funds in the pool and reduce the available funds
        if (entityFunds < _amount) revert FundsErrors.InsufficientAvailableFunds(entityFunds, _amount);

        // Use unchecked to optimize execution cost. The math is safe because of the require above.
        unchecked {
            availableFunds[_tokenAddress] = entityFunds - _amount;
        }

        // if available funds are totally emptied, the token address is removed from the seller's tokenList
        if (entityFunds == _amount) {
            // Get the index in the tokenList array, which is 1 less than the tokenIndexByAccount index
            address[] storage tokenList = entityLookups.tokenList;
            uint256 lastTokenIndex = tokenList.length - 1;
            mapping(address => uint256) storage entityTokens = pl.tokenIndexByAccount[_entityId];
            uint256 index = entityTokens[_tokenAddress] - 1;

            // if target is last index then only pop and delete are needed
            // otherwise, we overwrite the target with the last token first
            if (index != lastTokenIndex) {
                // Need to fill gap caused by delete if more than one element in storage array
                address tokenToMove = tokenList[lastTokenIndex];
                // Copy the last token in the array to this index to fill the gap
                tokenList[index] = tokenToMove;
                // Reset index mapping. Should be index in tokenList array + 1
                entityTokens[tokenToMove] = index + 1;
            }
            // Delete last token address in the array, which was just moved to fill the gap
            tokenList.pop();
            // Delete from index mapping
            delete entityTokens[_tokenAddress];
        }
    }

    /**
     * @notice Applies a percentage to the amount.
     *
     * @param _amount - the amount to apply the percentage to
     * @param _percentage - the percentage to apply
     */
    function applyPercentage(uint256 _amount, uint256 _percentage) internal pure returns (uint256) {
        return (_amount * _percentage) / HUNDRED_PERCENT;
    }
}
