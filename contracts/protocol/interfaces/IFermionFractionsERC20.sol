// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title FermionFractionsERC20 interface
 *
 * A set of methods to that extends ERC20 with Fermion fractions functionality.
 */
interface IFermionFractionsERC20 is IERC20 {
    /**
     * @dev Creates `value` tokens and assigns them to `account`.
     * Can only be called by the owner.
     */
    function mint(address account, uint256 value) external;

    /**
     * @dev Destroys `value` tokens from `account`.
     * Can only be called by the owner.
     */
    function burn(address account, uint256 value) external;

    /**
     * A special method to transfer fractions from one address to another. Not allowing burn or mint.
     */
    function transferFractionsFrom(address from, address to, uint256 value) external;
}
