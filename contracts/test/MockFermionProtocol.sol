// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import { FermionTypes } from "../protocol/domain/Types.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockFermionProtocol
 *
 * @notice A mock proxy contract acts as a Fermion protocol in tests
 *
 */
contract MockFermion {
    address private immutable DESTINATION;
    address private immutable EXCHANGE_TOKEN;
    address private destinationOverride;
    uint256 private amountToRelease;

    constructor(address _destination, address _exchangeToken) {
        DESTINATION = _destination;
        EXCHANGE_TOKEN = _exchangeToken;
    }

    function setupCustodianOfferVault(
        uint256 _firstTokenId,
        uint256 _length,
        FermionTypes.CustodianVaultParameters calldata custodianVaultParameters
    ) external {
        // do nothing
    }

    function addItemToCustodianOfferVault(uint256 _tokenId, uint256 _amount) external {
        // do nothing
    }

    function removeItemFromCustodianOfferVault(uint256 _tokenId) external returns (uint256 released) {
        // return funds if set so
        released = amountToRelease;
        if (released > 0) {
            IERC20(EXCHANGE_TOKEN).transfer(DESTINATION, released);
        }
    }

    function setDestinationOverride(address _destination) external {
        destinationOverride = _destination;
    }

    function setAmountToRelease(uint256 _amount) external {
        amountToRelease = _amount;
    }

    fallback() external payable {
        address to = destinationOverride == address(0) ? DESTINATION : destinationOverride;
        // do nothing
        (bool success, bytes memory data) = to.call(msg.data);

        delete destinationOverride;
    }
}
