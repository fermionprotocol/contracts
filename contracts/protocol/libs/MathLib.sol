// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HUNDRED_PERCENT } from "../domain/Constants.sol";

/**
 * @title MathLib
 *
 * @dev
 */
library MathLib {
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
