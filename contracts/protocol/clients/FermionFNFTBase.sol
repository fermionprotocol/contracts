// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import { ERC721Upgradeable as ERC721 } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

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

    /**
     * @notice Constructor
     *
     */
    constructor(address _bosonPriceDiscovery) {
        BP_PRICE_DISCOVERY = _bosonPriceDiscovery;
    }
}
