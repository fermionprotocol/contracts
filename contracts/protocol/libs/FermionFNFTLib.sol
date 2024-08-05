// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

// import { FermionGeneralErrors, CustodianVaultErrors } from "../domain/Errors.sol";
import { FermionTypes } from "../domain/Types.sol";
// import { FermionStorage } from "../libs/Storage.sol";
// import { FundsLib } from "../libs/FundsLib.sol";
// import { ICustodyEvents } from "../interfaces/events/ICustodyEvents.sol";

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";

/**
 * @title FermionFNFTLib
 *
 * @notice Appends own address to the data and forwards the call to the target address.
 */
library FermionFNFTLib {
    using Address for address;

    // function pushToNextTokenState(IFermionFNFT _fnft)
    function pushToNextTokenState(IFermionFNFT _fnft, uint256 _tokenId, FermionTypes.TokenState _newState) internal {
        address(_fnft).functionCall(
            appendAddress(abi.encodeCall(IFermionFNFT.pushToNextTokenState, (_tokenId, _newState)))
        );
    }

    function transferFrom(IFermionFNFT _fnft, address from, address to, uint256 tokenId) internal {
        address(_fnft).functionCall(
            appendAddress(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, tokenId))
        );
    }

    function transfer(IFermionFNFT _fnft, address to, uint256 value) internal returns (bool) {
        address(_fnft).functionCall(appendAddress(abi.encodeWithSignature("transfer(address,uint256)", to, value)));
    }

    function mintFractions(
        IFermionFNFT _fnft,
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _depositAmount
    ) internal {
        address(_fnft).functionCall(
            appendAddress(
                abi.encodeWithSignature(
                    "mintFractions(uint256,uint256,uint256)",
                    _firstTokenId,
                    _length,
                    _depositAmount
                )
            )
        );
    }

    function mintFractions(
        IFermionFNFT _fnft,
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _fractionsAmount,
        FermionTypes.BuyoutAuctionParameters memory _buyoutAuctionParameters,
        FermionTypes.CustodianVaultParameters memory _custodianVaultParameters,
        uint256 _depositAmount
    ) internal {
        address(_fnft).functionCall(
            appendAddress(
                abi.encodeWithSignature(
                    "mintFractions(uint256,uint256,uint256,(uint256,uint256,uint256,uint256),(uint256,uint256,uint256,uint256),uint256)",
                    _firstTokenId,
                    _length,
                    _fractionsAmount,
                    _buyoutAuctionParameters,
                    _custodianVaultParameters,
                    _depositAmount
                )
            )
        );
    }

    function mintAdditionalFractions(IFermionFNFT _fnft, uint256 _amount) internal {
        address(_fnft).functionCall(
            appendAddress(abi.encodeCall(IFermionFractions.mintAdditionalFractions, (_amount)))
        );
    }

    function transferOwnership(IFermionWrapper _fnft, address _newOwner) internal {
        address(_fnft).functionCall(appendAddress(abi.encodeCall(IFermionWrapper.transferOwnership, (_newOwner))));
    }

    function wrapForAuction(IFermionWrapper _fnft, uint256 _firstTokenId, uint256 _length, address _to) internal {
        address(_fnft).functionCall(
            appendAddress(abi.encodeCall(IFermionWrapper.wrapForAuction, (_firstTokenId, _length, _to)))
        );
    }

    function burn(address _fnft, uint256 _tokenId) internal returns (address wrappedVoucherOwner) {
        bytes memory returndata = address(_fnft).functionCall(
            appendAddress(abi.encodeCall(IFermionFNFT.burn, (_tokenId)))
        );
        wrappedVoucherOwner = abi.decode(returndata, (address));
        // require(returndata.length == 0 || abi.decode(returndata, (address)), "SafeERC20: ERC20 operation did not succeed");
    }

    function appendAddress(bytes memory data) internal view returns (bytes memory) {
        return abi.encodePacked(data, address(this));
    }
}
