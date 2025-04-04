// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import { FermionFNFT } from "../protocol/clients/FermionFNFT.sol";
import { SeaportWrapper } from "../protocol/clients/SeaportWrapper.sol";

/**
 * @title Test metatransaction _msgData() function
 *
 */
contract MetaTxTest is FermionFNFT {
    event IncomingData(bytes data);
    bytes public data;

    constructor(
        address _bosonPriceDiscovery,
        address _seaportWrapper,
        address _wrappedNative
    ) FermionFNFT(_bosonPriceDiscovery, _seaportWrapper, _wrappedNative) {}

    function testMsgData(bytes calldata) external {
        data = msg.data;
        emit IncomingData(_msgData());
    }
}

contract MetaTxTestSeaport is SeaportWrapper {
    event IncomingData(bytes data);
    bytes public data;

    constructor(
        address _bosonPriceDiscovery,
        SeaportConfig memory _seaportConfig,
        address _trustedForwarder
    ) SeaportWrapper(_bosonPriceDiscovery, _seaportConfig) {
        fermionProtocol = _trustedForwarder;
    }

    function testMsgData(bytes calldata) external {
        data = msg.data;
        emit IncomingData(_msgData());
    }
}
