// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FermionGeneralErrors } from "../../protocol/domain/Errors.sol";
import { Common } from "./Common.sol";

/**
 * @title FermionFNFTBase
 * @notice Base erc721 upgradeable contract for Fermion FNFTs
 *
 */
contract FermionFNFTBase is ERC721 {
    // Contract addresses
    address internal fermionProtocol;
    address internal voucherAddress;
    address internal immutable BP_PRICE_DISCOVERY; // Boson protocol Price Discovery client
    address private constant STRICT_AUTHORIZED_TRANSFER_SECURITY_REGISTRY = 0xA000027A9B2802E1ddf7000061001e5c005A0000; // ToDo: is constant? or chain specific?

    /**
     * @notice Constructor
     *
     */
    constructor(address _bosonPriceDiscovery) {
        if (_bosonPriceDiscovery == address(0)) revert FermionGeneralErrors.InvalidAddress();
        BP_PRICE_DISCOVERY = _bosonPriceDiscovery;
    }

    ///
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    error SameTransferValidator();

    function getTransferValidator() external view returns (address) {
        return Common._getFermionCommonStorage().transferValidator;
    }

    function _setTransferValidator(address newValidator) internal {
        Common.CommonStorage storage $ = Common._getFermionCommonStorage();
        address oldValidator = $.transferValidator;
        if (oldValidator == newValidator) {
            revert SameTransferValidator();
        }
        $.transferValidator = newValidator;
        emit TransferValidatorUpdated(oldValidator, newValidator);
    }

    function setTransferValidator(address newValidator) external {
        // ToDO: add access control
        _setTransferValidator(newValidator);
    }

    function toggleEnforcableRoyalties(bool _on) external {
        // ToDO: add access control
        _setTransferValidator(_on ? STRICT_AUTHORIZED_TRANSFER_SECURITY_REGISTRY : address(0));
    }

    /**
     * @notice Returns the transfer validation function used.
     */
    function getTransferValidationFunction() external pure returns (bytes4 functionSignature, bool isViewFunction) {
        functionSignature = ITransferValidator721.validateTransfer.selector;
        isViewFunction = false;
    }

    /**
     * @dev Hook that is called before any token transfer.
     *      This includes minting and burning.
     */
    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address) {
        address from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            // Call the transfer validator if one is set.
            address transferValidator = Common._getFermionCommonStorage().transferValidator;
            if (transferValidator != address(0)) {
                ITransferValidator721(transferValidator).validateTransfer(_msgSender(), from, to, tokenId);
            }
        }
        return from;
    }
}

interface ICreatorToken {
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    function getTransferValidator() external view returns (address validator);

    function getTransferValidationFunction() external view returns (bytes4 functionSignature, bool isViewFunction);

    function setTransferValidator(address validator) external;
}

interface ITransferValidator721 {
    /// @notice Ensure that a transfer has been authorized for a specific tokenId
    function validateTransfer(address caller, address from, address to, uint256 tokenId) external view;
}
