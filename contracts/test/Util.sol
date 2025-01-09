// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

/**
 * @title Solidity ABI encoder
 *
 * @notice Interface used in tests to abi encode complex structs
 *
 */
interface ABIEncoder {
    function encodeSeaportAdvancedOrder(SeaportTypes.AdvancedOrder calldata _buyerOrder) external;
}
