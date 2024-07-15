// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import { ConfigFacet } from "../protocol/facets/Config.sol";

/**
 * @title Test reentracy
 *
 */
contract ReentrancyTest {
    function testStaticCall(address _fermionProtocol) external view returns (address) {
        ConfigFacet configFacet = ConfigFacet(_fermionProtocol);
        return configFacet.getTreasuryAddress();
    }
}
