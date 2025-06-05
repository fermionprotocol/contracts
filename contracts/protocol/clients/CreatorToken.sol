// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { Common } from "./Common.sol";
import { OwnableUpgradeable as Ownable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ICreatorToken } from "./interfaces/ICreatorToken.sol";
import { ITransferValidator721 } from "./interfaces/ITransferValidator721.sol";
/**
 * @title CreatorToken
 * @notice Enforces transfer validation for creator tokens
 *
 */
contract CreatorToken is Ownable, ICreatorToken {
    /**
     * @notice Sets a new transfer validator
     *
     * Emits a TransferValidatorUpdated event if successful
     *
     * Reverts if:
     * - Caller is not the Contract owner
     * - The new validator is the same as the current one
     *
     * @param _newValidator The new transfer validator address.
     */
    function setTransferValidator(address _newValidator) external onlyOwner {
        _setTransferValidator(_newValidator);
    }

    /**
     * @notice Gets the current transfer validator
     *
     * @return transferValidator The current transfer validator address.
     */
    function getTransferValidator() external view returns (address transferValidator) {
        return Common._getFermionCommonStorage().transferValidator;
    }

    /**
     * @notice Returns the transfer validation function used.
     *
     * @return functionSignature The function signature of the transfer validation function.
     * @return isViewFunction True if the function is a view function, false otherwise.
     */
    function getTransferValidationFunction() external pure returns (bytes4 functionSignature, bool isViewFunction) {
        functionSignature = ITransferValidator721.validateTransfer.selector;
        isViewFunction = false;
    }

    /**
     * @notice Sets a new transfer validator
     *
     * Emits a TransferValidatorUpdated event if successful
     *
     * Reverts if:
     * - The new validator is the same as the current one
     *
     * @param _newValidator The new transfer validator address.
     */
    function _setTransferValidator(address _newValidator) internal {
        Common.CommonStorage storage $ = Common._getFermionCommonStorage();
        address oldValidator = $.transferValidator;
        if (oldValidator == _newValidator) {
            revert SameTransferValidator();
        }
        $.transferValidator = _newValidator;
        emit TransferValidatorUpdated(oldValidator, _newValidator);
    }
}
