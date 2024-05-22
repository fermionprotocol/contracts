// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockERC20 is ERC20 {
    uint256 private burnAmount;

    constructor() ERC20("MockERC20", "MCK_20") {}

    /**
     * Mints some tokens
     * @param _account - address that gets the tokens
     * @param _amount - amount to mint
     */
    function mint(address _account, uint256 _amount) public {
        _mint(_account, _amount);
    }

    /**
     * Sets the amount that is burned on every transfer
     */
    function setBurnAmount(uint256 _burnAmount) public {
        burnAmount = _burnAmount;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (burnAmount > 0 && to != address(0)) {
            _burn(from, burnAmount);
            amount -= burnAmount;
        }
        super._update(from, to, amount);
    }
}

contract MockERC721 is ERC721 {
    uint256 private burnAmount;

    constructor() ERC721("MockERC20", "MCK_20") {}

    /**
     * Mints some tokens
     * @param _account - address that gets the tokens
     * @param _startTokenId - starting token id
     * @param _amount - amount to mint
     */
    function mint(address _account, uint256 _startTokenId, uint256 _amount) public {
        for (uint256 i = 0; i < _amount; i++) {
            _mint(_account, _startTokenId + i);
        }
    }
}
