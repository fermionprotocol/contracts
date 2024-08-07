// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { FermionTypes } from "../domain/Types.sol";

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
    using FermionFNFTLib for address;

    function functionCallWithAddress(address _fnft, bytes memory data) internal returns (bytes memory) {
        return _fnft.functionCall(appendAddress(data));
    }

    function pushToNextTokenState(address _fnft, uint256 _tokenId, FermionTypes.TokenState _newState) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionFNFT.pushToNextTokenState, (_tokenId, _newState)));
    }

    function transferFrom(address _fnft, address from, address to, uint256 tokenId) internal {
        _fnft.functionCallWithAddress(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, tokenId)
        );
    }

    function transfer(address _fnft, address to, uint256 value) internal returns (bool) {
        _fnft.functionCallWithAddress(abi.encodeWithSignature("transfer(address,uint256)", to, value));
    }

    function mintFractions(address _fnft, uint256 _firstTokenId, uint256 _length, uint256 _depositAmount) internal {
        _fnft.functionCallWithAddress(
            abi.encodeWithSignature("mintFractions(uint256,uint256,uint256)", _firstTokenId, _length, _depositAmount)
        );
    }

    function mintFractions(
        address _fnft,
        uint256 _firstTokenId,
        uint256 _length,
        uint256 _fractionsAmount,
        FermionTypes.BuyoutAuctionParameters memory _buyoutAuctionParameters,
        FermionTypes.CustodianVaultParameters memory _custodianVaultParameters,
        uint256 _depositAmount
    ) internal {
        _fnft.functionCallWithAddress(
            abi.encodeWithSignature(
                "mintFractions(uint256,uint256,uint256,(uint256,uint256,uint256,uint256),(uint256,uint256,uint256,uint256),uint256)",
                _firstTokenId,
                _length,
                _fractionsAmount,
                _buyoutAuctionParameters,
                _custodianVaultParameters,
                _depositAmount
            )
        );
    }

    function mintAdditionalFractions(address _fnft, uint256 _amount) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionFractions.mintAdditionalFractions, (_amount)));
    }

    function transferOwnership(address _fnft, address _newOwner) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionWrapper.transferOwnership, (_newOwner)));
    }

    function wrapForAuction(address _fnft, uint256 _firstTokenId, uint256 _length, address _to) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionWrapper.wrapForAuction, (_firstTokenId, _length, _to)));
    }

    function burn(address _fnft, uint256 _tokenId) internal returns (address wrappedVoucherOwner) {
        bytes memory returndata = address(_fnft).functionCallWithAddress(abi.encodeCall(IFermionFNFT.burn, (_tokenId)));
        wrappedVoucherOwner = abi.decode(returndata, (address));
        // require(returndata.length == 0 || abi.decode(returndata, (address)), "SafeERC20: ERC20 operation did not succeed");
    }

    function appendAddress(bytes memory data) internal view returns (bytes memory) {
        return abi.encodePacked(data, address(this));
    }
}
