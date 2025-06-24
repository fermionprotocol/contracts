// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { FermionGeneralErrors } from "../../protocol/domain/Errors.sol";
import {
    ERC2771ContextUpgradeable as ERC2771Context
} from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import { ContextUpgradeable as Context } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";

/**
 * @title FermionFNFTBase
 * @notice Base erc721 upgradeable contract for Fermion FNFTs
 *
 */
abstract contract FermionFNFTBase is ERC721, ERC2771Context {
    // Contract addresses
    address internal immutable FERMION_PROTOCOL;
    address internal immutable BP_PRICE_DISCOVERY; // Boson protocol Price Discovery client

    uint256 internal emptySlot; // former fermionProtocol. Keep it to keep `voucherAddress` in slot 1.

    /**
     * @notice Constructor
     *
     */
    constructor(address _bosonPriceDiscovery, address _fermionProtocol) ERC2771Context(_fermionProtocol) {
        if (_bosonPriceDiscovery == address(0) || _fermionProtocol == address(0))
            revert FermionGeneralErrors.InvalidAddress();
        BP_PRICE_DISCOVERY = _bosonPriceDiscovery;
        FERMION_PROTOCOL = _fermionProtocol;
    }

    function _msgSender() internal view virtual override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view virtual override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view virtual override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}
