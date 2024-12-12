// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { SLOT_SIZE } from "../domain/Constants.sol";
import { FermionTypes } from "../domain/Types.sol";
import { FermionGeneralErrors } from "../domain/Errors.sol";

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IFermionFNFT } from "../interfaces/IFermionFNFT.sol";
import { IFermionFractions } from "../interfaces/IFermionFractions.sol";
import { IFermionWrapper } from "../interfaces/IFermionWrapper.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "seaport-types/src/lib/ConsiderationStructs.sol" as SeaportTypes;

/**
 * @title FermionFNFTLib
 *
 * @notice Appends own address to the data and forwards the call to the target address.
 */
library FermionFNFTLib {
    using Address for address;
    using FermionFNFTLib for address;

    /**
     * @notice Initializes the FNFT contract
     *
     * @param _voucherAddress The address of the Boson Voucher contract
     * @param _owner The address of the owner
     * @param _exchangeToken The address of the exchange token
     * @param _offerId The offer id
     * @param _metadataUri The metadata URI, used for all tokens and contract URI
     */
    function initialize(
        address _fnft,
        address _voucherAddress,
        address _owner,
        address _exchangeToken,
        uint256 _offerId,
        string memory _metadataUri
    ) internal {
        _fnft.functionCallWithAddress(
            abi.encodeCall(IFermionFNFT.initialize, (_voucherAddress, _owner, _exchangeToken, _offerId, _metadataUri))
        );
    }

    /**
     * @notice Pushes the F-NFT to next token state
     *
     * @param _tokenId The token id.
     * @param _newState The new token state
     */
    function pushToNextTokenState(address _fnft, uint256 _tokenId, FermionTypes.TokenState _newState) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionFNFT.pushToNextTokenState, (_tokenId, _newState)));
    }

    /**
     * @notice Transfers the ERC721 FNFT token or ERC20 FNFT fractions
     *
     * If _tokenIdOrValue is less than 2^128 the fractions are transferred, otherwise the token is transferred.
     *
     * @param _from The address to transfer from.
     * @param _to The address to transfer to.
     * @param _tokenIdOrValue The token id or value to transfer.
     */
    function transferFrom(address _fnft, address _from, address _to, uint256 _tokenIdOrValue) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IERC721.transferFrom, (_from, _to, _tokenIdOrValue)));
    }

    /**
     * @notice Transfers the ERC721 FNFT token
     *
     * @param _from The address to transfer from.
     * @param _to The address to transfer to.
     * @param _tokenId The token id.
     */
    function safeTransferFrom(address _fnft, address _from, address _to, uint256 _tokenId) internal {
        _fnft.functionCallWithAddress(
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", _from, _to, _tokenId)
        );
    }

    /**
     * @notice Transfers the ERC20 FNFT fractions
     *
     * N.B. Although the Fermion FNFT returns a boolean, as per ERC20 standard, it is not decoded here
     * since the the return value is not used in the protocol.
     *
     * @param _to The address to transfer to.
     * @param _value The number of fractions to transfer.
     */
    function transfer(address _fnft, address _to, uint256 _value) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionFractions.transfer, (_to, _value)));
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions. The number of fractions matches the number of fractions for existing NFTs.
     *
     * @param _firstTokenId The starting token ID
     * @param _length The number of tokens to fractionalise
     * @param _depositAmount - the amount to deposit
     */
    function mintFractions(address _fnft, uint256 _firstTokenId, uint256 _length, uint256 _depositAmount) internal {
        _fnft.functionCallWithAddress(
            abi.encodeWithSignature("mintFractions(uint256,uint256,uint256)", _firstTokenId, _length, _depositAmount)
        );
    }

    /**
     * @notice Locks the F-NFTs and mints the fractions. Sets the auction parameters and custodian vault parameters.
     *
     * @param _firstTokenId The starting token ID
     * @param _length The number of tokens to fractionalise
     * @param _fractionsAmount The number of fractions to mint for each NFT
     * @param _buyoutAuctionParameters The buyout auction parameters
     * @param _custodianVaultParameters The custodian vault parameters
     * @param _depositAmount - the amount to deposit
     */
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

    /**
     * @notice Mints additional fractions to be sold in the partial auction to fill the custodian vault.
     *
     * @param _amount The number of fractions to mint
     */
    function mintAdditionalFractions(address _fnft, uint256 _amount) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionFractions.mintAdditionalFractions, (_amount)));
    }

    /**
     * @notice Transfers the contract ownership to a new owner
     *
     * @param _newOwner The address of the new owner
     */
    function transferOwnership(address _fnft, address _newOwner) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionWrapper.transferOwnership, (_newOwner)));
    }

    /**
     * @notice Wraps the vouchers, transfer true vouchers to this contract and mint wrapped vouchers
     *
     * @param _firstTokenId The first token id.
     * @param _length The number of tokens to wrap.
     * @param _to The address to mint the wrapped tokens to.
     */
    function wrap(address _fnft, uint256 _firstTokenId, uint256 _length, address _to) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionWrapper.wrap, (_firstTokenId, _length, _to)));
    }

    /**
     * @notice Burns the token and returns the voucher owner
     *
     * @param _tokenId The token id.
     */
    function burn(address _fnft, uint256 _tokenId) internal returns (address wrappedVoucherOwner) {
        bytes memory returndata = address(_fnft).functionCallWithAddress(abi.encodeCall(IFermionFNFT.burn, (_tokenId)));

        if (returndata.length != SLOT_SIZE) revert FermionGeneralErrors.UnexpectedDataReturned(returndata);
        wrappedVoucherOwner = abi.decode(returndata, (address));
    }

    /**
     * @notice List fixed order on Seaport
     *
     * @param _firstTokenId The first token id.
     * @param _prices The prices for each token.
     * @param _endTimes The end times for each token.
     * @param _exchangeToken The token to be used for the exchange.
     */
    function listFixedPriceOrder(
        address _fnft,
        uint256 _firstTokenId,
        uint256[] calldata _prices,
        uint256[] calldata _endTimes,
        address _exchangeToken
    ) internal {
        _fnft.functionCallWithAddress(
            abi.encodeCall(IFermionWrapper.listFixedPriceOrder, (_firstTokenId, _prices, _endTimes, _exchangeToken))
        );
    }

    /**
     * @notice Cancel fixed price orders on OpenSea.
     *
     * @param _orders The orders to cancel.
     */
    function cancelFixedPriceOrder(address _fnft, SeaportTypes.OrderComponents[] calldata _orders) internal {
        _fnft.functionCallWithAddress(abi.encodeCall(IFermionWrapper.cancelFixedPriceOrder, (_orders)));
    }

    /**
     * @notice Append this contract's address to calldata and make a function call.
     *
     * @param _fnft - the FNFT contract address
     * @param _data - the calldata
     * @return the return data
     */
    function functionCallWithAddress(address _fnft, bytes memory _data) internal returns (bytes memory) {
        return _fnft.functionCall(appendAddress(_data));
    }

    /**
     * @notice Append this contract's address to the data.
     *
     * @param _data - the data
     * @return tha data with the address appended
     */
    function appendAddress(bytes memory _data) internal view returns (bytes memory) {
        return abi.encodePacked(_data, address(this));
    }
}
