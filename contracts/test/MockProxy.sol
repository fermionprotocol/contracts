// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title MockProxy
 *
 * @notice A mock proxy contract that inherits from ERC1967Proxy. Used in tests.
 *
 */
contract MockProxy is ERC1967Proxy {
    constructor(address implementation) ERC1967Proxy(implementation, "") {}
}
