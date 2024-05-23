// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { FermionErrors } from "../domain/Errors.sol";
import { FermionStorage } from "../libs/Storage.sol";
import { ContextLib } from "../libs/Context.sol";

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
     * Emits ERC20 Transfer event in call stack if successful.
     *
     * Reverts if:
     * - Offer price is in native token and caller does not send enough
     * - Offer price is in some ERC20 token and caller also sends native currency
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
            if (msg.value != _value) revert FermionErrors.InsufficientValueReceived(_value, msg.value);
        } else {
            // when price is in an erc20 token, transferring the native currency is not allowed
            if (msg.value != 0) revert FermionErrors.NativeNotAllowed();

            // if transfer is in ERC20 token, try to transfer the amount from buyer to the protocol
            transferFundsToProtocol(_exchangeToken, ContextLib.msgSender(), _value);
        }
    }

    /**
     * @notice Tries to transfer tokens from the caller to the protocol.
     *
     * Emits ERC20 Transfer event in call stack if successful.
     *
     * Reverts if:
     * - Contract at token address does not support ERC20 function transferFrom
     * - Calling transferFrom on token fails for some reason (e.g. protocol is not approved to transfer)
     * - Received ERC20 token amount differs from the expected value
     *
     * @param _tokenAddress - address of the token to be transferred
     * @param _from - address to transfer funds from
     * @param _amount - amount to be transferred
     */
    function transferFundsToProtocol(address _tokenAddress, address _from, uint256 _amount) internal {
        // protocol balance before the transfer
        uint256 protocolTokenBalanceBefore = IERC20(_tokenAddress).balanceOf(address(this));

        // transfer ERC20 tokens from the caller
        IERC20(_tokenAddress).safeTransferFrom(_from, address(this), _amount);

        // protocol balance after the transfer
        uint256 protocolTokenBalanceAfter = IERC20(_tokenAddress).balanceOf(address(this));

        // make sure that expected amount of tokens was transferred
        uint256 receivedAmount = protocolTokenBalanceAfter - protocolTokenBalanceBefore;
        if (receivedAmount != _amount) revert FermionErrors.InsufficientValueReceived(_amount, receivedAmount);
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
        mapping(address => uint256) storage availableFunds = pl.availableFunds[_entityId];
        if (availableFunds[_tokenAddress] == 0) {
            address[] storage tokenList = pl.tokenList[_entityId];
            tokenList.push(_tokenAddress);
            //Set index mapping. Should be index in tokenList array + 1
            pl.tokenIndexByAccount[_entityId][_tokenAddress] = tokenList.length;
        }

        // update the available funds
        availableFunds[_tokenAddress] += _amount;
    }
}
