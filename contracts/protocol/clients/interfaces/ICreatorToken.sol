// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;
interface ICreatorToken {
    event TransferValidatorUpdated(address oldValidator, address newValidator);
    error SameTransferValidator();
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
    function setTransferValidator(address _newValidator) external;

    /**
     * @notice Gets the current transfer validator
     *
     * @return transferValidator The current transfer validator address.
     */
    function getTransferValidator() external view returns (address transferValidator);

    /**
     * @notice Returns the transfer validation function used.
     *
     * @return functionSignature The function signature of the transfer validation function.
     * @return isViewFunction True if the function is a view function, false otherwise.
     */
    function getTransferValidationFunction() external view returns (bytes4 functionSignature, bool isViewFunction);
}
