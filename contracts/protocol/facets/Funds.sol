// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionStorage } from "../libs/Storage.sol";

/**
 * @title FundsFacet
 *
 * @notice Handles entity funds.
 */
contract FundsFacet {
    /**
     * @notice Gets the information about the available funds for an entity.
     *
     * @param _entityId - the entity ID
     * @param _token - the token address
     * @return amount - the amount available to withdraw
     */
    function getAvailableFunds(uint256 _entityId, address _token) external view returns (uint256 amount) {
        return FermionStorage.protocolLookups().availableFunds[_entityId][_token];
    }
}
