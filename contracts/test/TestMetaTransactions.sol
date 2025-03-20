// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import { FermionFNFT } from "../protocol/clients/FermionFNFT.sol";
import { SeaportWrapper } from "../protocol/clients/SeaportWrapper.sol";
import { FermionFractionsERC20 } from "../protocol/clients/FermionFractionsERC20.sol";

/**
 * @title Test metatransaction _msgData() function
 *
 */
contract MetaTxTest is FermionFNFT {
    event IncomingData(bytes data);
    bytes public data;

    constructor(
        address _bosonPriceDiscovery,
        address _fermionProtocol,
        address _seaportWrapper,
        address _strictAuthorizedTransferSecurityRegistry,
        address _wrappedNative,
        address _fnftFractionMint,
        address _fermionFNFTPriceManager,
        address _fnftBuyoutAuction
    )
        FermionFNFT(
            _bosonPriceDiscovery,
            _fermionProtocol,
            _seaportWrapper,
            _strictAuthorizedTransferSecurityRegistry,
            _wrappedNative,
            _fnftFractionMint,
            _fermionFNFTPriceManager,
            _fnftBuyoutAuction
        )
    {}

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
        address _fermionProtocol,
        SeaportConfig memory _seaportConfig,
        address _trustedForwarder
    ) SeaportWrapper(_bosonPriceDiscovery, _fermionProtocol, _seaportConfig) {
        fermionProtocol = _trustedForwarder;
    }

    function testMsgData(bytes calldata) external {
        data = msg.data;
        emit IncomingData(_msgData());
    }
}

contract MetaTxTestFractions is FermionFractionsERC20 {
    event IncomingData(bytes data);
    bytes public data;

    constructor(address _fermionProtocol) FermionFractionsERC20(_fermionProtocol) {}

    function testMsgData(bytes calldata) external {
        data = msg.data;
        emit IncomingData(_msgData());
    }
}
