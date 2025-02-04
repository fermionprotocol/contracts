// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { Common } from "./Common.sol";
import { OwnableUpgradeable as Ownable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface ICreatorToken {
    event TransferValidatorUpdated(address oldValidator, address newValidator);
    error SameTransferValidator();

    function getTransferValidator() external view returns (address validator);

    function getTransferValidationFunction() external view returns (bytes4 functionSignature, bool isViewFunction);

    function setTransferValidator(address validator) external;
}

/**
 * @title CreatorToken
 * @notice Enforces transfer validation for creator tokens
 *
 */
contract CreatorToken is Ownable, ICreatorToken {
    function getTransferValidator() external view returns (address) {
        return Common._getFermionCommonStorage().transferValidator;
    }

    function _setTransferValidator(address newValidator) internal {
        Common.CommonStorage storage $ = Common._getFermionCommonStorage();
        address oldValidator = $.transferValidator;
        if (oldValidator == newValidator) {
            revert SameTransferValidator();
        }
        $.transferValidator = newValidator;
        emit TransferValidatorUpdated(oldValidator, newValidator);
    }

    function setTransferValidator(address newValidator) external onlyOwner {
        _setTransferValidator(newValidator);
    }

    /**
     * @notice Returns the transfer validation function used.
     */
    function getTransferValidationFunction() external pure returns (bytes4 functionSignature, bool isViewFunction) {
        functionSignature = ITransferValidator721.validateTransfer.selector;
        isViewFunction = false;
    }
}

interface ITransferValidator721 {
    /// @notice Ensure that a transfer has been authorized for a specific tokenId
    function validateTransfer(address caller, address from, address to, uint256 tokenId) external view;
}
