// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { SLOT_SIZE } from "../../domain/Constants.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC2771Context } from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import { FundsErrors, FermionGeneralErrors } from "../../domain/Errors.sol";
import { FermionStorage } from "../../libs/Storage.sol";
import { ContextLib } from "../../libs/ContextLib.sol";
import { FermionFNFTLib } from "../../libs/FermionFNFTLib.sol";
import { IFundsEvents } from "../../interfaces/events/IFundsEvents.sol";
import { NativeClaims } from "../../libs/NativeClaims.sol";

/**
 * @title Funds Manager Base Contract
 *
 * @notice Base contract providing funds management functionality used by multiple facets
 */
contract FundsManager {
    using SafeERC20 for IERC20;
    using FermionFNFTLib for address;
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
            transferERC20ToProtocol(_exchangeToken, ContextLib._msgSender(), _value);
        }
    }

    /**
     * @notice Tries to transfer tokens from the specified address to the protocol.
     *
     * Reverts if:
     * - The called contract is ERC721
     * - Contract at token address does not support ERC20 function transferFrom
     * - Calling transferFrom on token fails for some reason (e.g. protocol is not approved to transfer)
     * - Received ERC20 token amount differs from the expected value
     *
     * N.B. Special caution is needed when interacting with the FermionFNFT contract,
     * as it treats _msgSender() differently when the caller is the Fermion protocol.
     * If FundsLib methods are used in the contracts that are not part of the diamond,
     * `checkTrustedForwarder` should be overridden to return false.
     *
     * @param _tokenAddress - address of the token to be transferred
     * @param _from - address to transfer funds from
     * @param _amount - amount to be transferred
     */
    function transferERC20ToProtocol(address _tokenAddress, address _from, uint256 _amount) internal {
        // prevent ERC721 deposits
        isERC721Contract(_tokenAddress, false);

        uint256 protocolTokenBalanceBefore = IERC20(_tokenAddress).balanceOf(address(this));

        // transfer ERC20 tokens from the caller
        if (checkTrustedForwarder(_tokenAddress)) {
            _tokenAddress.transferFrom(_from, address(this), _amount);
        } else {
            IERC20(_tokenAddress).safeTransferFrom(_from, address(this), _amount);
        }

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
     * @notice For native currency transfers (when _tokenAddress is address(0)), this function attempts direct transfer.
     *         If the transfer fails, the transaction will revert. For more flexible native currency handling,
     *         use the overloaded version with _storeNativeForClaim parameter.
     *
     * @param _entityId - id of entity for which funds should be decreased, or 0 for protocol
     * @param _tokenAddress - address of the token to be transferred
     * @param _to - address of the recipient
     * @param _amount - amount to be transferred
     */
    function transferERC20FromProtocol(
        uint256 _entityId,
        address _tokenAddress,
        address payable _to,
        uint256 _amount
    ) internal {
        // first decrease the amount to prevent the reentrancy attack
        decreaseAvailableFunds(_entityId, _tokenAddress, _amount);

        // try to transfer the funds
        transferERC20FromProtocol(_tokenAddress, _to, _amount);

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
     * @notice For funds currency transfers, this function attempts direct transfer.
     *         If the transfer fails, the transaction will revert. For more flexible native currency handling,
     *         use the overloaded version with _storeNativeForClaim parameter.
     *
     * @param _tokenAddress - address of the token to be transferred
     * @param _to - address of the recipient
     * @param _amount - amount to be transferred
     */
    function transferERC20FromProtocol(address _tokenAddress, address payable _to, uint256 _amount) internal virtual {
        transferERC20FromProtocol(_tokenAddress, _to, _amount, false);
    }

    /**
     * @notice Transfers ERC20 tokens or native currency from the protocol to a recipient
     *
     * Reverts if:
     * - Transfer of native currency is not successful (i.e. recipient is a contract which reverts)
     * - Contract at token address does not support ERC20 function transfer
     * - Available funds is less than amount to be decreased
     *
     * @notice For native funds transfers:
     *         - If _storeNativeForClaim is true, the amount is stored for later claim by the recipient
     *         - If _storeNativeForClaim is false, attempts direct transfer (may revert on failure)
     *
     * @param _tokenAddress The address of the token (0x0 for native currency)
     * @param _to The recipient address
     * @param _amount The amount to transfer
     * @param _storeNativeForClaim Whether to store native currency for later claim instead of direct transfer
     */
    function transferERC20FromProtocol(
        address _tokenAddress,
        address payable _to,
        uint256 _amount,
        bool _storeNativeForClaim
    ) internal virtual {
        // try to transfer the funds
        if (_tokenAddress == address(0)) {
            if (_storeNativeForClaim) {
                // Store native amount for later claim
                NativeClaims._addClaim(_to, _amount);
            } else {
                // transfer native currency directly
                (bool success, bytes memory errorMessage) = _to.call{ value: _amount }("");
                if (!success) revert FundsErrors.TokenTransferFailed(_to, _amount, errorMessage);
            }
        } else {
            // transfer ERC20 tokens
            if (checkTrustedForwarder(_tokenAddress)) {
                _tokenAddress.transfer(_to, _amount);
            } else {
                IERC20(_tokenAddress).safeTransfer(_to, _amount);
            }
        }
    }

    /**
     * @notice Checks if the contract at the token address is FNFT or not.
     *
     * @dev override this function in the child contract does not need this check
     *
     * @param _tokenAddress - address of the token to be transferred
     */
    function checkTrustedForwarder(address _tokenAddress) internal view virtual returns (bool) {
        (bool success, bytes memory returnData) = _tokenAddress.staticcall(
            abi.encodeCall(ERC2771Context.trustedForwarder, ())
        );

        if (success) {
            if (returnData.length != SLOT_SIZE) {
                return false;
            }
            return address(uint160(abi.decode(returnData, (uint256)))) == address(this);
        }
        return false;
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
            unchecked {
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
    }

    /**
     * @notice Tries to transfer ERC721 tokens from the specified address to the protocol.
     *
     * Emits ERC721Deposited event if successful.
     *
     * Reverts if:
     * - Contract at token address does not support ERC721 function transferFrom
     * - Calling transferFrom on token fails for some reason (e.g. protocol is not approved to transfer)
     * - The protocol does not own the token after the transfer
     *
     * @param _tokenAddress - address of the token to be transferred
     * @param _from - address to transfer erc721 from
     * @param _tokenId - token id to be transferred
     */
    function transferERC721ToProtocol(address _tokenAddress, address _from, uint256 _tokenId) internal {
        isERC721Contract(_tokenAddress, true);

        // transfer ERC721 tokens from the caller
        if (checkTrustedForwarder(_tokenAddress)) {
            _tokenAddress.transferFrom(_from, address(this), _tokenId);
        } else {
            IERC721(_tokenAddress).transferFrom(_from, address(this), _tokenId);
        }

        // make sure that expected token was transferred
        if (IERC721(_tokenAddress).ownerOf(_tokenId) != address(this)) {
            revert FundsErrors.ERC721TokenNotTransferred(_tokenAddress, _tokenId);
        }

        emit IFundsEvents.ERC721Deposited(_tokenAddress, _tokenId, _from);
    }

    /** @notice Tries to transfer ERC721 tokens from the protocol to the recipient.
     *
     * Emits ERC721Withdrawn event if successful.
     *
     * Reverts if:
     * - Transfer of ERC721 tokens is not successful (i.e. recipient is a contract which reverts)
     */
    function transferERC721FromProtocol(address _tokenAddress, address _to, uint256 _tokenId) internal {
        // N.B. We do not check if the token is ERC721 here since:
        // 1. If the seller is withdrawing the token, it must be attached to some offer and it was validated upon deposit#
        // 2. If the buyer is withdrawing the token, they cannot plug in an arbitrary token address

        // transfer ERC721 tokens from the protocol
        if (checkTrustedForwarder(_tokenAddress)) {
            _tokenAddress.safeTransferFrom(address(this), _to, _tokenId);
        } else {
            IERC721(_tokenAddress).safeTransferFrom(address(this), _to, _tokenId);
        }

        emit IFundsEvents.ERC721Withdrawn(_tokenAddress, _tokenId, _to);
    }

    /**
     * @notice Checks if the contract at the token address is ERC721 or not.
     *
     * Reverts if:
     * - Call succeeded but returned unexpected data
     * - Call failed with a reason
     * - Returned value is not 0 or 1
     * - Call suceeded but the result is not as expected
     * - Call failed with a reason
     * - Call failed with a reason and the ERC721 is expected
     *
     * @param _tokenAddress - address of the token to be transferred
     * @param _erc721expected - true if the contract is expected to be ERC721, false otherwise
     */
    function isERC721Contract(address _tokenAddress, bool _erc721expected) internal view {
        (bool success, bytes memory returnData) = _tokenAddress.staticcall(
            abi.encodeCall(IERC165.supportsInterface, (type(IERC721).interfaceId))
        );

        if (success) {
            if (returnData.length != SLOT_SIZE) {
                revert FermionGeneralErrors.UnexpectedDataReturned(returnData);
            } else {
                // If returned value equals 1 (= true), the contract is ERC721 and we should revert
                uint256 result = abi.decode(returnData, (uint256)); // decoding into uint256 not bool to cover all cases

                if (result > 1) revert FermionGeneralErrors.UnexpectedDataReturned(returnData);

                // If we expect ERC721 and the contract is not ERC721, revert.
                // If we do not expect ERC721 and the contract is ERC721, revert.
                if ((result == 1) != _erc721expected)
                    revert FundsErrors.ERC721CheckFailed(_tokenAddress, _erc721expected);
            }
        } else {
            if (returnData.length == 0) {
                if (_erc721expected) {
                    revert FundsErrors.ERC721CheckFailed(_tokenAddress, _erc721expected);
                }

                // If ERC721 is not expected, do nothing. ERC20 not implementing IERC721 interface is expected to revert without reason.
            } else {
                // If an actual error message is returned, revert with it
                /// @solidity memory-safe-assembly
                assembly {
                    revert(add(SLOT_SIZE, returnData), mload(returnData))
                }
            }
        }
    }
}
