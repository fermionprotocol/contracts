// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockPriceOracle {
    uint256 private price;
    bool private shouldRevertWithInvalidPrice;
    bool private shouldRevertWithOtherError;

    error InvalidPrice();
    error OtherError();

    function setPrice(uint256 _price) external {
        price = _price;
    }

    function enableInvalidPriceRevert(bool _shouldRevert) external {
        shouldRevertWithInvalidPrice = _shouldRevert;
    }

    function enableOtherErrorRevert(bool _shouldRevert) external {
        shouldRevertWithOtherError = _shouldRevert;
    }

    function getPrice() external view returns (uint256) {
        if (shouldRevertWithInvalidPrice) {
            revert InvalidPrice();
        }
        if (shouldRevertWithOtherError) {
            revert OtherError();
        }
        return price;
    }
}
