// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../../domain/Types.sol";

/**
 * @title IMetaTransactionEvents
 *
 * @notice Defines events related to meta-transactions.
 */
interface IMetaTransactionEvents {
    event MetaTransactionExecuted(
        address indexed wallet,
        address indexed caller,
        string indexed functionName,
        uint256 nonce
    );
    event FunctionsAllowlisted(bytes32[] functionNameHashes, bool isAllowlisted, address indexed caller);
}
